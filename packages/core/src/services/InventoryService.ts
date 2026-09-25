import type { Database } from "@gestion-boutique/database";
import { schema, withTransaction } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { and, desc, eq, sql } from "drizzle-orm";
import { roundMoney } from "../domain/money";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { checkApproval, verifyApprovalInput, type ApprovalInput } from "./ApprovalService";
import { logAction } from "./AuditService";
import { consumeStockFefo, recordMovement } from "./StockService";

// Inventaire physique d'un emplacement. Démarrage : on fige la liste des
// produits avec leur coût (la quantité théorique du moment est gardée mais NE
// s'affiche PAS pendant le comptage — comptage en aveugle). Clôture : pour
// chaque ligne comptée, l'écart est calculé contre le stock théorique AU
// MOMENT de la clôture (compter et clôturer dans la même séance, sans vendre
// entre-temps), puis régularisé par un mouvement "inventaire" tracé.
// Limite connue : ces régularisations ne sont pas répliquées vers les autres
// appareils du mode réseau (comme les achats).

type StockCount = typeof schema.stockCounts.$inferSelect;
type StockCountLine = typeof schema.stockCountLines.$inferSelect;

async function balanceAt(db: Database, variantId: number, locationId: number): Promise<number> {
  const row = await db
    .select({ total: sql<number>`COALESCE(SUM(${schema.stockMovements.quantityDelta}), 0)` })
    .from(schema.stockMovements)
    .where(and(eq(schema.stockMovements.variantId, variantId), eq(schema.stockMovements.locationId, locationId)))
    .get();
  return row?.total ?? 0;
}

const nowSql = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export async function getOpenStockCount(db: Database, locationId: number): Promise<StockCount | undefined> {
  return db
    .select()
    .from(schema.stockCounts)
    .where(and(eq(schema.stockCounts.locationId, locationId), eq(schema.stockCounts.status, "open")))
    .get();
}

export async function listStockCounts(db: Database, locationId?: number): Promise<StockCount[]> {
  const query = db.select().from(schema.stockCounts).orderBy(desc(schema.stockCounts.id));
  return locationId ? query.where(eq(schema.stockCounts.locationId, locationId)) : query;
}

export async function getStockCountLines(db: Database, countId: number): Promise<StockCountLine[]> {
  return db.select().from(schema.stockCountLines).where(eq(schema.stockCountLines.countId, countId));
}

export interface StartStockCountInput {
  locationId: number;
  storeId?: number;
  userId: number;
}

export async function startStockCount(db: Database, input: StartStockCountInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_stock");
  if (await getOpenStockCount(db, input.locationId)) {
    throw new Error(t("coreErrors.inventory.alreadyOpen"));
  }

  const count = await withTransaction(async () => {
    const created = await db
      .insert(schema.stockCounts)
      .values({ storeId: input.storeId, locationId: input.locationId, startedBy: input.userId })
      .returning()
      .get();

    const variants = await db
      .select({ variantId: schema.productVariants.id, cost: schema.products.purchasePrice })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId));
    for (const v of variants) {
      await db.insert(schema.stockCountLines).values({
        countId: created.id,
        variantId: v.variantId,
        systemQuantity: await balanceAt(db, v.variantId, input.locationId),
        unitCost: v.cost,
      });
    }
    return created;
  });

  await logAction(db, {
    userId: input.userId,
    action: "stock_count_start",
    entity: "stock_count",
    entityId: count.id,
    metadata: { locationId: input.locationId },
  });
  return count;
}

export interface SaveCountedQuantityInput {
  countId: number;
  variantId: number;
  // null efface la saisie (produit non compté).
  countedQuantity: number | null;
}

export async function saveCountedQuantity(db: Database, input: SaveCountedQuantityInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_stock");
  const count = await db.select().from(schema.stockCounts).where(eq(schema.stockCounts.id, input.countId)).get();
  if (!count || count.status !== "open") throw new Error(t("coreErrors.inventory.notOpen"));
  if (input.countedQuantity != null && input.countedQuantity < 0) throw new Error(t("coreErrors.inventory.negative"));
  await db
    .update(schema.stockCountLines)
    .set({ countedQuantity: input.countedQuantity })
    .where(and(eq(schema.stockCountLines.countId, input.countId), eq(schema.stockCountLines.variantId, input.variantId)))
    .run();
}

export interface CloseStockCountInput {
  countId: number;
  userId: number;
  note?: string;
  approval?: ApprovalInput;
}

export interface StockCountVariance {
  variantId: number;
  systemQuantity: number;
  countedQuantity: number;
  difference: number;
  unitCost: number;
  value: number; // écart valorisé au coût (négatif = manquant)
}

export interface CloseStockCountResult {
  count: StockCount;
  variances: StockCountVariance[];
  missingValue: number; // valeur des manquants (positif)
  surplusValue: number; // valeur des surplus (positif)
  uncountedLines: number;
}

// Calcule les écarts d'un inventaire (fonction pure).
export function computeVariances(
  lines: { variantId: number; countedQuantity: number | null; unitCost: number | null }[],
  systemNow: Map<number, number>,
): StockCountVariance[] {
  const out: StockCountVariance[] = [];
  for (const line of lines) {
    if (line.countedQuantity == null) continue;
    const system = systemNow.get(line.variantId) ?? 0;
    const difference = roundMoney(line.countedQuantity - system);
    const unitCost = line.unitCost ?? 0;
    out.push({
      variantId: line.variantId,
      systemQuantity: system,
      countedQuantity: line.countedQuantity,
      difference,
      unitCost,
      value: roundMoney(difference * unitCost),
    });
  }
  return out;
}

export async function closeStockCount(
  db: Database,
  input: CloseStockCountInput,
  actingPermissions: PermissionSet,
): Promise<CloseStockCountResult> {
  requirePermission(actingPermissions, "manage_stock");
  const count = await db.select().from(schema.stockCounts).where(eq(schema.stockCounts.id, input.countId)).get();
  if (!count || count.status !== "open") throw new Error(t("coreErrors.inventory.notOpen"));

  // Vérifié hors transaction (compteur d'essais du responsable).
  const verifiedApproverId = await verifyApprovalInput(db, input.userId, input.approval);

  const lines = await getStockCountLines(db, input.countId);
  const uncountedLines = lines.filter((l) => l.countedQuantity == null).length;
  if (uncountedLines === lines.length) throw new Error(t("coreErrors.inventory.nothingCounted"));

  const result = await withTransaction(async () => {
    const systemNow = new Map<number, number>();
    for (const line of lines) {
      if (line.countedQuantity != null) systemNow.set(line.variantId, await balanceAt(db, line.variantId, count.locationId));
    }
    const variances = computeVariances(lines, systemNow);
    const missingValue = roundMoney(variances.filter((v) => v.difference < 0).reduce((s, v) => s + Math.abs(v.value), 0));
    const surplusValue = roundMoney(variances.filter((v) => v.difference > 0).reduce((s, v) => s + v.value, 0));

    // Plafond : la régularisation est un mouvement de stock sensible (elle peut
    // effacer un vol) — même contrôle que les pertes/entrées manuelles.
    const approvedBy = await checkApproval(db, {
      kind: "stock",
      amount: roundMoney(missingValue + surplusValue),
      userId: input.userId,
      actingPermissions,
      verifiedApproverId,
    });

    const note = t("inventory.movementNote", { id: count.id });
    for (const v of variances) {
      if (v.difference === 0) continue;
      if (v.difference < 0) {
        await consumeStockFefo(db, {
          variantId: v.variantId,
          locationId: count.locationId,
          quantity: Math.abs(v.difference),
          movementType: "adjustment",
          referenceType: "inventory",
          referenceId: count.id,
          userId: input.userId,
          note,
          approvedBy: approvedBy ?? undefined,
        });
      } else {
        await recordMovement(db, {
          variantId: v.variantId,
          locationId: count.locationId,
          quantityDelta: v.difference,
          movementType: "adjustment",
          referenceType: "inventory",
          referenceId: count.id,
          userId: input.userId,
          note,
          approvedBy: approvedBy ?? undefined,
        });
      }
    }

    // Fige la quantité théorique réellement utilisée pour chaque ligne comptée.
    for (const v of variances) {
      await db
        .update(schema.stockCountLines)
        .set({ systemQuantity: v.systemQuantity })
        .where(and(eq(schema.stockCountLines.countId, count.id), eq(schema.stockCountLines.variantId, v.variantId)))
        .run();
    }

    const closed = await db
      .update(schema.stockCounts)
      .set({
        status: "closed",
        closedBy: input.userId,
        closedAt: nowSql(),
        approvedBy: approvedBy ?? undefined,
        note: input.note?.trim() || undefined,
      })
      .where(eq(schema.stockCounts.id, count.id))
      .returning()
      .get();

    return { count: closed, variances, missingValue, surplusValue };
  });

  await logAction(db, {
    userId: input.userId,
    action: "stock_count_close",
    entity: "stock_count",
    entityId: count.id,
    metadata: {
      locationId: count.locationId,
      counted: lines.length - uncountedLines,
      uncounted: uncountedLines,
      missingValue: result.missingValue,
      surplusValue: result.surplusValue,
      approvedBy: result.count.approvedBy,
    },
  });

  return { ...result, uncountedLines };
}

// Rapport d'un inventaire clôturé : lignes comptées avec leur écart valorisé.
export async function getStockCountReport(
  db: Database,
  countId: number,
): Promise<{ count: StockCount; variances: StockCountVariance[]; missingValue: number; surplusValue: number }> {
  const count = await db.select().from(schema.stockCounts).where(eq(schema.stockCounts.id, countId)).get();
  if (!count) throw new Error(t("coreErrors.inventory.notFound"));
  const lines = await getStockCountLines(db, countId);
  const systemMap = new Map(lines.map((l) => [l.variantId, l.systemQuantity] as const));
  const variances = computeVariances(lines, systemMap);
  return {
    count,
    variances,
    missingValue: roundMoney(variances.filter((v) => v.difference < 0).reduce((s, v) => s + Math.abs(v.value), 0)),
    surplusValue: roundMoney(variances.filter((v) => v.difference > 0).reduce((s, v) => s + v.value, 0)),
  };
}
