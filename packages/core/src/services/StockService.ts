import type { Database } from "@gestion-boutique/database";
import { schema, withTransaction } from "@gestion-boutique/database";
import { formatMoneyPlain, t } from "@gestion-boutique/i18n";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { DEFAULT_LOCATIONS, type DefaultLocationKey } from "../domain/stock";
import { computeSellableQuantity, isExpired, selectBatchesForConsumption, todayISO } from "../domain/expiry";
import { areEquivalent, breakdownUnitCost } from "../domain/pharmacy";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { buildApprovalRequestCreatedEvent, createApprovalRequest, describeVariant, requireApproval, requireApprovalDeferrable, type ApprovalInput } from "./ApprovalService";
import { logAction } from "./AuditService";
import {
  buildSyncEvent,
  emitSyncEvent,
  type SyncEvent,
  type StockBreakdownCreatedEventPayload,
  type StockEntryCreatedEventPayload,
  type StockLossCreatedEventPayload,
  type StockTransferCreatedEventPayload,
} from "../sync/syncEvents";
import { localDayEndUtc, localDayStartUtc } from "../domain/localDay";

// Idempotent : crée les emplacements par défaut (Réserve / Surface de vente)
// d'une boutique s'ils n'existent pas encore, puis retourne leurs ids. Le
// type ('reserve'/'surface_vente') reste globalement unique en base
// (contrainte historique, antérieure au multi-boutique) — la première
// boutique à réclamer un type le garde tel quel (rétrocompatibilité totale
// avec les bases mono-boutique existantes), toute boutique suivante reçoit un
// type suffixé par son id.
export async function ensureLocationsForStore(
  db: Database,
  storeId: number,
): Promise<Record<DefaultLocationKey, number>> {
  const result = {} as Record<DefaultLocationKey, number>;

  for (const key of Object.keys(DEFAULT_LOCATIONS) as DefaultLocationKey[]) {
    const location = DEFAULT_LOCATIONS[key];

    const existingForStore = await db
      .select()
      .from(schema.stockLocations)
      .where(and(eq(schema.stockLocations.storeId, storeId), eq(schema.stockLocations.type, location.type)))
      .get();
    if (existingForStore) {
      result[key] = existingForStore.id;
      continue;
    }

    const typeConflict = await db
      .select()
      .from(schema.stockLocations)
      .where(eq(schema.stockLocations.type, location.type))
      .get();
    const typeValue = typeConflict ? `${location.type}#${storeId}` : location.type;

    const created = await db
      .insert(schema.stockLocations)
      .values({ name: location.name, type: typeValue, storeId })
      .returning()
      .get();

    result[key] = created.id;
  }

  return result;
}

export async function listLocations(db: Database, storeId?: number) {
  const query = db.select().from(schema.stockLocations);
  return storeId ? query.where(eq(schema.stockLocations.storeId, storeId)) : query;
}

export interface RecordMovementInput {
  variantId: number;
  locationId: number;
  quantityDelta: number;
  movementType: "purchase" | "sale" | "transfer" | "adjustment" | "loss" | "return";
  referenceType?: string;
  referenceId?: number;
  batchId?: number;
  userId?: number;
  // Motif libre et responsable ayant approuvé (mouvements manuels).
  note?: string;
  approvedBy?: number;
  // Voir CLAUDE.md, mode réseau Phase 2 — généré si omis (appel hors
  // contexte de synchronisation, ex. tests, achats).
  syncId?: string;
}

export async function recordMovement(db: Database, input: RecordMovementInput) {
  return db
    .insert(schema.stockMovements)
    .values({
      syncId: input.syncId ?? crypto.randomUUID(),
      variantId: input.variantId,
      locationId: input.locationId,
      quantityDelta: input.quantityDelta,
      movementType: input.movementType,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      batchId: input.batchId,
      createdBy: input.userId,
      note: input.note,
      approvedBy: input.approvedBy,
    })
    .returning()
    .get();
}

// Solde d'une variante à un emplacement (somme du grand livre).
async function getLocationBalance(db: Database, variantId: number, locationId: number): Promise<number> {
  const row = await db
    .select({ total: sql<number>`COALESCE(SUM(${schema.stockMovements.quantityDelta}), 0)` })
    .from(schema.stockMovements)
    .where(and(eq(schema.stockMovements.variantId, variantId), eq(schema.stockMovements.locationId, locationId)))
    .get();
  return row?.total ?? 0;
}

// Valeur au coût d'un mouvement de stock (prix d'achat courant du produit) —
// sert de base aux plafonds d'approbation.
export async function valueAtCost(db: Database, variantId: number, quantity: number): Promise<number> {
  const row = await db
    .select({ cost: schema.products.purchasePrice })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(eq(schema.productVariants.id, variantId))
    .get();
  return Math.abs(quantity) * (row?.cost ?? 0);
}

export interface StockMovementFilters {
  from?: string; // "YYYY-MM-DD"
  to?: string;
  userId?: number;
  movementType?: string;
  locationId?: number;
}

// Le grand livre des mouvements sert lui-même de journal de sortie/entrée de
// stock — inutile de dupliquer ces événements dans audit_log.
export async function listStockMovements(db: Database, filters: StockMovementFilters = {}) {
  const conditions = [];
  if (filters.from) conditions.push(gte(schema.stockMovements.createdAt, localDayStartUtc(filters.from)));
  if (filters.to) conditions.push(lte(schema.stockMovements.createdAt, localDayEndUtc(filters.to)));
  if (filters.userId) conditions.push(eq(schema.stockMovements.createdBy, filters.userId));
  if (filters.movementType) conditions.push(eq(schema.stockMovements.movementType, filters.movementType));
  if (filters.locationId) conditions.push(eq(schema.stockMovements.locationId, filters.locationId));

  const query = db.select().from(schema.stockMovements).orderBy(desc(schema.stockMovements.id));
  return conditions.length > 0 ? query.where(and(...conditions)) : query;
}

export interface TransferStockInput {
  variantId: number;
  fromLocationId: number;
  toLocationId: number;
  quantity: number;
  userId?: number;
}

// Un transfert doit conserver la traçabilité par lot (coût, péremption) —
// sans ça, le stock qui passe de la Réserve à la Surface de vente perdrait
// son lot d'origine et retomberait dans le "reliquat sans lot" de
// consumeStockFefo, ce qui fausserait le calcul de marge réel dès qu'un
// achat suit le flux normal Achat → Réserve → Transfert → Vente (voir le
// commentaire sur getCostOfGoodsSoldBySaleAndVariant dans ReportsService).
// Même ordre FEFO que consumeStockFefo pour décider quel(s) lot(s) source
// sont consommés en premier ; chaque lot source consommé se prolonge par un
// lot "miroir" au même coût/péremption à l'emplacement de destination.
export async function transferStock(
  db: Database,
  input: TransferStockInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "transfer_stock");
  if (input.quantity <= 0) throw new Error(t("coreErrors.stock.quantityPositive"));
  if (input.fromLocationId === input.toLocationId) throw new Error(t("coreErrors.stock.sameLocation"));
  // Un lot périmé ne part jamais vers la surface de vente : seule la quantité
  // vendable (hors périmés) peut être transférée.
  const today = todayISO();
  const stockInfo = await getSellableQuantity(db, input.variantId, input.fromLocationId, today);
  if (input.quantity > stockInfo.total) throw new Error(t("coreErrors.stock.insufficient", { available: stockInfo.total }));
  if (input.quantity > stockInfo.sellable) {
    throw new Error(t("coreErrors.pharmacy.expiredStock", { available: stockInfo.sellable, expired: stockInfo.expiredRemaining }));
  }

  // Enveloppé dans withTransaction (Phase 2, voir CLAUDE.md) — jusqu'ici
  // cette fonction ne l'était pas (gap déjà noté dans les pistes), ce qui
  // veut aussi dire que c'est un prérequis pour pouvoir répliquer son
  // résultat comme un tout atomique.
  const event = await withTransaction(async () => {
    const batches = await db
      .select()
      .from(schema.stockBatches)
      .where(
        and(
          eq(schema.stockBatches.variantId, input.variantId),
          eq(schema.stockBatches.locationId, input.fromLocationId),
        ),
      );
    const remainingMap = await getBatchRemainingMap(db, batches.map((b) => b.id));
    const withRemaining = selectBatchesForConsumption(
      batches.map((batch) => ({ batch, remaining: remainingMap.get(batch.id) ?? 0 })),
      today,
      { includeExpired: false },
    );

    const legs: StockTransferCreatedEventPayload["legs"] = [];

    let toTransfer = input.quantity;
    for (const { batch, remaining } of withRemaining) {
      if (toTransfer <= 0) break;
      const take = Math.min(toTransfer, remaining);
      if (take <= 0) continue;

      const sourceMovement = await recordMovement(db, {
        variantId: input.variantId,
        locationId: input.fromLocationId,
        quantityDelta: -take,
        movementType: "transfer",
        batchId: batch.id,
        userId: input.userId,
      });

      // Nouveau lot par transfert plutôt que de chercher à en réutiliser un
      // existant à destination — reste simple, et le nombre de lots créés
      // demeure proportionnel aux mouvements réels.
      const destBatch = await createBatch(db, {
        variantId: input.variantId,
        locationId: input.toLocationId,
        lotNumber: batch.lotNumber ?? undefined,
        expiryDate: batch.expiryDate ?? undefined,
        quantity: take,
        unitCost: batch.unitCost ?? undefined,
      });

      const destMovement = await recordMovement(db, {
        variantId: input.variantId,
        locationId: input.toLocationId,
        quantityDelta: take,
        movementType: "transfer",
        batchId: destBatch.id,
        userId: input.userId,
      });

      legs.push({
        sourceMovement: {
          syncId: sourceMovement.syncId!,
          variantId: sourceMovement.variantId,
          locationId: sourceMovement.locationId,
          batchSyncId: batch.syncId,
          quantityDelta: sourceMovement.quantityDelta,
          movementType: sourceMovement.movementType,
          referenceType: sourceMovement.referenceType,
        },
        destMovement: {
          syncId: destMovement.syncId!,
          variantId: destMovement.variantId,
          locationId: destMovement.locationId,
          batchSyncId: destBatch.syncId,
          quantityDelta: destMovement.quantityDelta,
          movementType: destMovement.movementType,
          referenceType: destMovement.referenceType,
        },
        destBatch: {
          syncId: destBatch.syncId!,
          variantId: destBatch.variantId,
          locationId: destBatch.locationId,
          lotNumber: destBatch.lotNumber,
          expiryDate: destBatch.expiryDate,
          quantity: destBatch.quantity,
          unitCost: destBatch.unitCost,
        },
      });

      toTransfer -= take;
    }

    // Reliquat sans lot (produit non suivi par lot, ou lots insuffisants) —
    // comme avant l'introduction du suivi par lot, aucune rupture de
    // compatibilité pour les produits qui n'en ont jamais eu.
    if (toTransfer > 0) {
      const sourceMovement = await recordMovement(db, {
        variantId: input.variantId,
        locationId: input.fromLocationId,
        quantityDelta: -toTransfer,
        movementType: "transfer",
        userId: input.userId,
      });
      const destMovement = await recordMovement(db, {
        variantId: input.variantId,
        locationId: input.toLocationId,
        quantityDelta: toTransfer,
        movementType: "transfer",
        userId: input.userId,
      });
      legs.push({
        sourceMovement: {
          syncId: sourceMovement.syncId!,
          variantId: sourceMovement.variantId,
          locationId: sourceMovement.locationId,
          batchSyncId: null,
          quantityDelta: sourceMovement.quantityDelta,
          movementType: sourceMovement.movementType,
          referenceType: sourceMovement.referenceType,
        },
        destMovement: {
          syncId: destMovement.syncId!,
          variantId: destMovement.variantId,
          locationId: destMovement.locationId,
          batchSyncId: null,
          quantityDelta: destMovement.quantityDelta,
          movementType: destMovement.movementType,
          referenceType: destMovement.referenceType,
        },
      });
    }

    return buildSyncEvent<StockTransferCreatedEventPayload>("stockTransfer.created", { legs });
  });

  emitSyncEvent(event);

  await logAction(db, {
    userId: input.userId ?? null,
    action: "stock_transfer",
    entity: "stock",
    entityId: input.variantId,
    metadata: { variantId: input.variantId, from: input.fromLocationId, to: input.toLocationId, quantity: input.quantity },
  });
}

export interface StockLevel {
  variantId: number;
  locationId: number;
  quantity: number;
}

// Emplacements appartenant à une boutique donnée — utilisé pour scoper les
// fonctions ci-dessous par boutique quand le multi-boutique est activé.
async function locationIdsForStore(db: Database, storeId: number): Promise<number[]> {
  const rows = await db
    .select({ id: schema.stockLocations.id })
    .from(schema.stockLocations)
    .where(eq(schema.stockLocations.storeId, storeId));
  return rows.map((r) => r.id);
}

// Le solde n'est jamais stocké : il se calcule à partir du grand livre des
// mouvements (SUM des deltas), comme en comptabilité. `storeId` restreint le
// calcul aux emplacements de cette boutique (mono-boutique = tous, storeId
// omis).
export async function getStockLevels(db: Database, storeId?: number): Promise<StockLevel[]> {
  const query = db
    .select({
      variantId: schema.stockMovements.variantId,
      locationId: schema.stockMovements.locationId,
      quantity: sql<number>`SUM(${schema.stockMovements.quantityDelta})`,
    })
    .from(schema.stockMovements)
    .groupBy(schema.stockMovements.variantId, schema.stockMovements.locationId);

  const rows = storeId
    ? await query.where(inArray(schema.stockMovements.locationId, await locationIdsForStore(db, storeId)))
    : await query;

  return rows.map((r) => ({
    variantId: r.variantId,
    locationId: r.locationId,
    quantity: Number(r.quantity),
  }));
}

export interface LowStockEntry {
  product: typeof schema.products.$inferSelect;
  variantId: number;
  totalStock: number;
}

export async function getLowStockProducts(db: Database, storeId?: number): Promise<LowStockEntry[]> {
  const [products, variants, levels] = await Promise.all([
    db.select().from(schema.products),
    db.select().from(schema.productVariants),
    getStockLevels(db, storeId),
  ]);

  const stockByVariant = new Map<number, number>();
  for (const level of levels) {
    stockByVariant.set(level.variantId, (stockByVariant.get(level.variantId) ?? 0) + level.quantity);
  }

  const result: LowStockEntry[] = [];
  for (const product of products) {
    const productVariants = variants.filter((v) => v.productId === product.id);
    const totalStock = productVariants.reduce((sum, v) => sum + (stockByVariant.get(v.id) ?? 0), 0);
    if (totalStock <= product.lowStockThreshold) {
      result.push({ product, variantId: productVariants[0]?.id ?? 0, totalStock });
    }
  }
  return result;
}

// Vitesse de vente réelle sur les `days` derniers jours (par variante), lue
// depuis le grand livre `stock_movements` (mouvements `movementType='sale'`
// — `quantityDelta` y est négatif, donc `-quantityDelta` = unités vendues).
// Sert de base au réappro prédictif (voir PurchasesPage.tsx) : couvrir la
// consommation réelle plutôt qu'un simple multiple du seuil d'alerte fixe.
export async function getSalesVelocity(
  db: Database,
  days = 30,
  storeId?: number,
): Promise<Map<number, number>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  const conditions = [eq(schema.stockMovements.movementType, "sale"), gte(schema.stockMovements.createdAt, since)];
  if (storeId) {
    conditions.push(inArray(schema.stockMovements.locationId, await locationIdsForStore(db, storeId)));
  }

  const rows = await db
    .select({
      variantId: schema.stockMovements.variantId,
      sold: sql<number>`SUM(-${schema.stockMovements.quantityDelta})`,
    })
    .from(schema.stockMovements)
    .where(and(...conditions))
    .groupBy(schema.stockMovements.variantId);

  const velocity = new Map<number, number>();
  for (const row of rows) {
    velocity.set(row.variantId, Number(row.sold) / days);
  }
  return velocity;
}

export interface CreateBatchInput {
  variantId: number;
  locationId: number;
  lotNumber?: string;
  expiryDate?: string;
  quantity: number;
  // Coût d'achat unitaire de ce lot — renseigné par PurchasesService, absent
  // pour une entrée de stock manuelle (voir le commentaire sur la colonne
  // dans schema/stock.ts).
  unitCost?: number;
  // Voir CLAUDE.md, mode réseau Phase 2 — généré si omis.
  syncId?: string;
}

export async function createBatch(db: Database, input: CreateBatchInput) {
  return db
    .insert(schema.stockBatches)
    .values({ ...input, syncId: input.syncId ?? crypto.randomUUID() })
    .returning()
    .get();
}

export interface ManualStockEntryInput {
  variantId: number;
  locationId: number;
  quantity: number;
  lotNumber?: string;
  expiryDate?: string;
  userId?: number;
  // Motif obligatoire : une entrée manuelle peut masquer un vol (stock gonflé
  // pour compenser une sortie non déclarée).
  note: string;
  approval?: ApprovalInput;
}

// Entrée de stock manuelle (StockPage) — distincte des mouvements internes
// (achat, vente, transfert, remboursement), qui portent chacun leur propre
// permission via leur flux d'origine et appellent directement createBatch/
// recordMovement (primitives volontairement non gardées, car partagées par
// ces flux). Celle-ci est le seul point d'entrée de saisie manuelle, donc
// gardée elle-même.
export async function addManualStockEntry(
  db: Database,
  input: ManualStockEntryInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_stock");
  if (input.quantity <= 0) throw new Error(t("coreErrors.stock.quantityPositive"));
  if (!input.note.trim()) throw new Error(t("coreErrors.stock.noteRequired"));
  const value = await valueAtCost(db, input.variantId, input.quantity);
  // Entrée sous le mode « à valider ensuite » : appliquée tout de suite, la demande
  // sert au propriétaire à la valider (ou la contester) après coup.
  const { approvedBy, deferred } = await requireApprovalDeferrable(db, {
    kind: "stock",
    amount: value,
    userId: input.userId,
    actingPermissions,
    approval: input.approval,
  });
  const productName = await describeVariant(db, input.variantId);
  const balanceBefore = await getLocationBalance(db, input.variantId, input.locationId);

  // Enveloppé dans withTransaction (Phase 2, voir CLAUDE.md) — prérequis
  // pour répliquer lot+mouvement comme un seul événement atomique.
  let requestEvent: SyncEvent | undefined;
  const event = await withTransaction(async () => {
    let batchId: number | undefined;
    let batchPayload: StockEntryCreatedEventPayload["batch"];
    if (input.expiryDate) {
      const batch = await createBatch(db, {
        variantId: input.variantId,
        locationId: input.locationId,
        lotNumber: input.lotNumber,
        expiryDate: input.expiryDate,
        quantity: input.quantity,
      });
      batchId = batch.id;
      batchPayload = {
        syncId: batch.syncId!,
        variantId: batch.variantId,
        locationId: batch.locationId,
        lotNumber: batch.lotNumber,
        expiryDate: batch.expiryDate,
        quantity: batch.quantity,
      };
    }

    const movement = await recordMovement(db, {
      variantId: input.variantId,
      locationId: input.locationId,
      quantityDelta: input.quantity,
      movementType: "adjustment",
      referenceType: "manual",
      batchId,
      userId: input.userId,
      note: input.note.trim(),
      approvedBy: approvedBy ?? undefined,
    });

    if (deferred) {
      const request = await createApprovalRequest(db, {
        kind: "stock",
        amount: value,
        requestedBy: input.userId,
        summary: t("approvalRequests.summary.stockEntry", { quantity: input.quantity, product: productName, value: formatMoneyPlain(value), note: input.note.trim() }),
        payload: { movementIds: [movement.id], movementSyncIds: [movement.syncId] },
      });
      requestEvent = buildApprovalRequestCreatedEvent(request);
    }

    return buildSyncEvent<StockEntryCreatedEventPayload>("stockEntry.created", {
      batch: batchPayload,
      movement: {
        syncId: movement.syncId!,
        variantId: movement.variantId,
        locationId: movement.locationId,
        batchSyncId: batchPayload?.syncId ?? null,
        quantityDelta: movement.quantityDelta,
        movementType: movement.movementType,
        referenceType: movement.referenceType,
      },
    }, { actorId: input.userId, approverId: approvedBy });
  });

  emitSyncEvent(event);
  if (requestEvent) emitSyncEvent(requestEvent);

  await logAction(db, {
    userId: input.userId ?? null,
    action: "stock_entry",
    entity: "stock",
    entityId: input.variantId,
    metadata: {
      variantId: input.variantId,
      locationId: input.locationId,
      quantity: input.quantity,
      before: balanceBefore,
      after: balanceBefore + input.quantity,
      value,
      note: input.note.trim(),
      approvedBy,
    },
  });
}

export interface RecordStockLossInput {
  variantId: number;
  locationId: number;
  quantity: number;
  reason: string;
  // Détail libre complétant le motif (ex. "carton tombé du camion").
  note?: string;
  userId?: number;
  approval?: ApprovalInput;
}

// Retrait pour perte/péremption/casse/vol (StockPage) — même raisonnement
// que addManualStockEntry ci-dessus.
export async function recordStockLoss(
  db: Database,
  input: RecordStockLossInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "record_stock_losses");
  if (input.quantity <= 0) throw new Error(t("coreErrors.stock.quantityPositive"));
  const balanceBefore = await getLocationBalance(db, input.variantId, input.locationId);
  if (input.quantity > balanceBefore) throw new Error(t("coreErrors.stock.insufficient", { available: balanceBefore }));
  const value = await valueAtCost(db, input.variantId, input.quantity);
  const { approvedBy, deferred } = await requireApprovalDeferrable(db, {
    kind: "stock",
    amount: value,
    userId: input.userId,
    actingPermissions,
    approval: input.approval,
  });
  const productName = await describeVariant(db, input.variantId);

  // Enveloppé dans withTransaction (Phase 2, voir CLAUDE.md) — une seule
  // écriture ici, mais la cohérence de convention avec les autres
  // opérations réplicables importe plus que la brièveté.
  let requestEvent: SyncEvent | undefined;
  const event = await withTransaction(async () => {
    const movement = await recordMovement(db, {
      variantId: input.variantId,
      locationId: input.locationId,
      quantityDelta: -input.quantity,
      movementType: "loss",
      referenceType: input.reason,
      userId: input.userId,
      note: input.note?.trim() || undefined,
      approvedBy: approvedBy ?? undefined,
    });

    if (deferred) {
      const request = await createApprovalRequest(db, {
        kind: "stock",
        amount: value,
        requestedBy: input.userId,
        summary: t("approvalRequests.summary.stockLoss", { quantity: input.quantity, product: productName, value: formatMoneyPlain(value), reason: t(`journals.lossReasons.${input.reason}`, { defaultValue: input.reason }) }),
        payload: { movementIds: [movement.id], movementSyncIds: [movement.syncId] },
      });
      requestEvent = buildApprovalRequestCreatedEvent(request);
    }

    return buildSyncEvent<StockLossCreatedEventPayload>("stockLoss.created", {
      movement: {
        syncId: movement.syncId!,
        variantId: movement.variantId,
        locationId: movement.locationId,
        batchSyncId: null,
        quantityDelta: movement.quantityDelta,
        movementType: movement.movementType,
        referenceType: movement.referenceType,
      },
    }, { actorId: input.userId, approverId: approvedBy });
  });

  emitSyncEvent(event);
  if (requestEvent) emitSyncEvent(requestEvent);

  await logAction(db, {
    userId: input.userId ?? null,
    action: "stock_loss",
    entity: "stock",
    entityId: input.variantId,
    metadata: {
      variantId: input.variantId,
      locationId: input.locationId,
      quantity: input.quantity,
      before: balanceBefore,
      after: balanceBefore - input.quantity,
      value,
      reason: input.reason,
      note: input.note?.trim() || null,
      approvedBy,
    },
  });
}

// Utilisé par Journaux pour afficher le numéro de lot d'un mouvement de
// stock (mouvement.batchId → lot.lotNumber) — simple lecture, pas de
// recalcul de solde ici (voir getBatchRemainingMap pour ça).
export async function listBatches(db: Database) {
  return db.select().from(schema.stockBatches);
}

// Solde restant par lot — même principe que getStockLevels (jamais stocké,
// toujours recalculé depuis le grand livre), mais groupé par batchId au lieu
// de variantId+locationId. Alimenté par consumeStockFefo (ventes) et par
// RefundsService (retours), qui taguent chacun de leurs mouvements avec le
// bon batchId — voir ces deux fonctions.
export async function getBatchRemainingMap(db: Database, batchIds: number[]): Promise<Map<number, number>> {
  if (batchIds.length === 0) return new Map();
  const rows = await db
    .select({
      batchId: schema.stockMovements.batchId,
      quantity: sql<number>`SUM(${schema.stockMovements.quantityDelta})`,
    })
    .from(schema.stockMovements)
    .where(inArray(schema.stockMovements.batchId, batchIds))
    .groupBy(schema.stockMovements.batchId);

  const map = new Map<number, number>();
  for (const row of rows) {
    if (row.batchId != null) map.set(row.batchId, Number(row.quantity));
  }
  return map;
}

export interface ConsumeStockInput {
  variantId: number;
  locationId: number;
  quantity: number;
  movementType: "sale" | "adjustment";
  referenceType?: string;
  referenceId?: number;
  userId?: number;
  note?: string;
  approvedBy?: number;
  // Vendre/consommer aussi les lots périmés. Par défaut : jamais pour une vente
  // (un périmé ne se vend pas), toujours pour un ajustement (écart d'inventaire).
  // Une vente ne passe à `true` qu'avec la dérogation approuvée d'un responsable.
  includeExpired?: boolean;
}

// Décrémente le stock en respectant l'ordre FEFO (premier expiré, premier
// sorti) parmi les lots existants pour ce produit+emplacement — chaque
// mouvement de sortie est tagué avec le batchId exact d'où il provient,
// permettant une traçabilité vente/remboursement ↔ lot précis (voir
// RefundsService.createRefund pour la réattribution au remboursement). Le
// reliquat éventuel (produit non suivi en péremption, ou lots insuffisants)
// part sans batchId, comme avant l'introduction du suivi par lot — aucune
// rupture de compatibilité pour les produits sans lot.
//
// Renvoie les mouvements créés (voir CLAUDE.md, mode réseau Phase 2) : une
// vente peut consommer plusieurs lots pour une seule ligne, `createSale` a
// besoin de tous les mouvements réellement produits pour construire son
// événement de synchronisation.
export async function consumeStockFefo(
  db: Database,
  input: ConsumeStockInput,
): Promise<Array<typeof schema.stockMovements.$inferSelect>> {
  const movements: Array<typeof schema.stockMovements.$inferSelect> = [];
  const batches = await db
    .select()
    .from(schema.stockBatches)
    .where(
      and(eq(schema.stockBatches.variantId, input.variantId), eq(schema.stockBatches.locationId, input.locationId)),
    );

  const remainingMap = await getBatchRemainingMap(db, batches.map((b) => b.id));
  const withRemaining = selectBatchesForConsumption(
    batches.map((batch) => ({ batch, remaining: remainingMap.get(batch.id) ?? 0 })),
    todayISO(),
    { includeExpired: input.includeExpired ?? input.movementType !== "sale" },
  );

  let toConsume = input.quantity;
  for (const { batch, remaining } of withRemaining) {
    if (toConsume <= 0) break;
    const take = Math.min(toConsume, remaining);
    if (take <= 0) continue;
    movements.push(
      await recordMovement(db, {
        variantId: input.variantId,
        locationId: input.locationId,
        quantityDelta: -take,
        movementType: input.movementType,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        batchId: batch.id,
        userId: input.userId,
        note: input.note,
        approvedBy: input.approvedBy,
      }),
    );
    toConsume -= take;
  }

  if (toConsume > 0) {
    movements.push(
      await recordMovement(db, {
        variantId: input.variantId,
        locationId: input.locationId,
        quantityDelta: -toConsume,
        movementType: input.movementType,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        userId: input.userId,
        note: input.note,
        approvedBy: input.approvedBy,
      }),
    );
  }

  return movements;
}

export interface SellableInfo {
  // Solde total de la variante à cet emplacement (périmés compris).
  total: number;
  // Partie réellement vendable (hors lots périmés).
  sellable: number;
  // Quantité encore en stock dans des lots périmés.
  expiredRemaining: number;
}

// Stock vendable d'une variante à un emplacement : le solde du grand livre moins
// ce qui reste dans des lots périmés. Voir computeSellableQuantity pour le cas
// des anciennes sorties enregistrées sans lot.
export async function getSellableQuantity(
  db: Database,
  variantId: number,
  locationId: number,
  today: string = todayISO(),
): Promise<SellableInfo> {
  const total = await getLocationBalance(db, variantId, locationId);
  const batches = await db
    .select()
    .from(schema.stockBatches)
    .where(and(eq(schema.stockBatches.variantId, variantId), eq(schema.stockBatches.locationId, locationId)));
  const remainingMap = await getBatchRemainingMap(db, batches.map((b) => b.id));
  let allBatchesRemaining = 0;
  let expiredRemaining = 0;
  for (const batch of batches) {
    const remaining = remainingMap.get(batch.id) ?? 0;
    if (remaining <= 0) continue;
    allBatchesRemaining += remaining;
    if (isExpired(batch.expiryDate, today)) expiredRemaining += remaining;
  }
  return {
    total,
    expiredRemaining,
    sellable: computeSellableQuantity({ total, expiredRemaining, allBatchesRemaining }),
  };
}

export interface ExpiredBatchEntry {
  batch: typeof schema.stockBatches.$inferSelect;
  variant: typeof schema.productVariants.$inferSelect;
  productName: string;
  remaining: number;
  // Valeur au coût du lot (coût du lot, repli sur le prix d'achat du produit).
  value: number;
}

// Lots périmés qui contiennent encore du stock, avec leur valeur perdue.
export async function listExpiredBatches(db: Database, storeId?: number): Promise<ExpiredBatchEntry[]> {
  const expiring = await listExpiringBatches(db, 0, storeId);
  const today = todayISO();
  const expired = expiring.filter((e) => isExpired(e.batch.expiryDate, today));
  if (expired.length === 0) return [];
  const remainingMap = await getBatchRemainingMap(db, expired.map((e) => e.batch.id));
  const products = await db.select().from(schema.products);
  const productById = new Map(products.map((p) => [p.id, p] as const));
  return expired.map(({ batch, variant }) => {
    const product = productById.get(variant.productId);
    const remaining = remainingMap.get(batch.id) ?? 0;
    return {
      batch,
      variant,
      productName: product?.name ?? `#${variant.id}`,
      remaining,
      value: remaining * (batch.unitCost ?? product?.purchasePrice ?? 0),
    };
  });
}

export interface WriteOffExpiredInput {
  // Rebuter seulement ces lots (sinon tous les lots périmés de la boutique).
  batchIds?: number[];
  storeId?: number;
  userId?: number;
  approval?: ApprovalInput;
}

// Rebut des lots périmés : une sortie « perte / péremption » PAR LOT (le lot est
// ainsi réellement vidé et disparaît des alertes, ce que l'ancien retrait manuel
// ne faisait pas). Au-delà du seuil d'approbation stock, un responsable valide
// avec son code (toujours en mode code, jamais en validation ultérieure : la
// marchandise est déjà inutilisable, il n'y a rien à « annuler » après coup).
export async function writeOffExpiredBatches(
  db: Database,
  input: WriteOffExpiredInput,
  actingPermissions: PermissionSet,
): Promise<{ batches: number; units: number; value: number }> {
  requirePermission(actingPermissions, "record_stock_losses");
  const all = await listExpiredBatches(db, input.storeId);
  const targets = all.filter((e) => e.remaining > 0 && (!input.batchIds || input.batchIds.includes(e.batch.id)));
  if (targets.length === 0) throw new Error(t("coreErrors.pharmacy.nothingExpired"));
  const value = targets.reduce((sum, e) => sum + e.value, 0);
  const approvedBy = await requireApproval(db, {
    kind: "stock",
    amount: value,
    userId: input.userId,
    actingPermissions,
    approval: input.approval,
  });

  const events: SyncEvent[] = [];
  await withTransaction(async () => {
    for (const entry of targets) {
      const movement = await recordMovement(db, {
        variantId: entry.variant.id,
        locationId: entry.batch.locationId,
        quantityDelta: -entry.remaining,
        movementType: "loss",
        referenceType: "expiry",
        batchId: entry.batch.id,
        userId: input.userId,
        note: entry.batch.lotNumber ? `lot ${entry.batch.lotNumber}` : undefined,
        approvedBy: approvedBy ?? undefined,
      });
      events.push(
        buildSyncEvent<StockLossCreatedEventPayload>("stockLoss.created", {
          movement: {
            syncId: movement.syncId!,
            variantId: movement.variantId,
            locationId: movement.locationId,
            batchSyncId: entry.batch.syncId,
            quantityDelta: movement.quantityDelta,
            movementType: movement.movementType,
            referenceType: movement.referenceType,
          },
        }),
      );
    }
  });
  for (const event of events) emitSyncEvent(event);

  const units = targets.reduce((sum, e) => sum + e.remaining, 0);
  await logAction(db, {
    userId: input.userId ?? null,
    action: "stock_expired_writeoff",
    entity: "stock",
    metadata: {
      batches: targets.length,
      units,
      value,
      lots: targets.map((e) => ({ product: e.productName, lot: e.batch.lotNumber, expiryDate: e.batch.expiryDate, quantity: e.remaining })),
      approvedBy,
    },
  });
  return { batches: targets.length, units, value };
}

export interface BreakDownPackInput {
  // Variante « boîte » à ouvrir, et variante détaillée (plaquette…) qui reçoit les unités.
  parentVariantId: number;
  childVariantId: number;
  locationId: number;
  // Nombre de boîtes à ouvrir.
  quantity: number;
  userId?: number;
}

// Ouvre des boîtes : -N boîtes, +N × contenance unités détaillées, au même
// emplacement. Le lot SUIT (même numéro, même péremption) et le coût de la boîte
// est réparti sur ses unités — le stock garde sa valeur. Les lots périmés ne
// s'ouvrent jamais (sinon une boîte périmée redeviendrait vendable en détail).
export async function breakDownPack(db: Database, input: BreakDownPackInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "transfer_stock");
  if (!(input.quantity > 0)) throw new Error(t("coreErrors.pharmacy.breakQuantityPositive"));
  const child = await db
    .select()
    .from(schema.productVariants)
    .where(eq(schema.productVariants.id, input.childVariantId))
    .get();
  if (!child || child.parentVariantId !== input.parentVariantId || !((child.unitsPerParent ?? 0) > 0)) {
    throw new Error(t("coreErrors.pharmacy.noPackLink"));
  }
  const units = child.unitsPerParent!;
  const product = await db.select().from(schema.products).where(eq(schema.products.id, child.productId)).get();
  const productCost = product?.purchasePrice ?? 0;

  const today = todayISO();
  const info = await getSellableQuantity(db, input.parentVariantId, input.locationId, today);
  if (input.quantity > info.sellable) {
    throw new Error(t("coreErrors.pharmacy.notEnoughToBreak", { available: info.sellable }));
  }

  const event = await withTransaction(async () => {
    const batches = await db
      .select()
      .from(schema.stockBatches)
      .where(
        and(eq(schema.stockBatches.variantId, input.parentVariantId), eq(schema.stockBatches.locationId, input.locationId)),
      );
    const remainingMap = await getBatchRemainingMap(db, batches.map((b) => b.id));
    const withRemaining = selectBatchesForConsumption(
      batches.map((batch) => ({ batch, remaining: remainingMap.get(batch.id) ?? 0 })),
      today,
      { includeExpired: false },
    );

    const legs: StockBreakdownCreatedEventPayload["legs"] = [];
    const openOne = async (take: number, batch: (typeof batches)[number] | undefined) => {
      const sourceMovement = await recordMovement(db, {
        variantId: input.parentVariantId,
        locationId: input.locationId,
        quantityDelta: -take,
        movementType: "adjustment",
        referenceType: "breakdown",
        batchId: batch?.id,
        userId: input.userId,
      });
      // Toujours un lot pour les unités détaillées (même sans lot d'origine) : sans
      // lui, la marge retomberait sur le prix d'achat du PRODUIT, c'est-à-dire celui
      // d'une boîte entière appliqué à une seule plaquette.
      const destBatch = await createBatch(db, {
        variantId: input.childVariantId,
        locationId: input.locationId,
        lotNumber: batch?.lotNumber ?? undefined,
        expiryDate: batch?.expiryDate ?? undefined,
        quantity: take * units,
        unitCost: breakdownUnitCost(batch?.unitCost ?? productCost, units),
      });
      const destMovement = await recordMovement(db, {
        variantId: input.childVariantId,
        locationId: input.locationId,
        quantityDelta: take * units,
        movementType: "adjustment",
        referenceType: "breakdown",
        batchId: destBatch.id,
        userId: input.userId,
      });
      legs.push({
        sourceMovement: {
          syncId: sourceMovement.syncId!,
          variantId: sourceMovement.variantId,
          locationId: sourceMovement.locationId,
          batchSyncId: batch?.syncId ?? null,
          quantityDelta: sourceMovement.quantityDelta,
          movementType: sourceMovement.movementType,
          referenceType: sourceMovement.referenceType,
        },
        destMovement: {
          syncId: destMovement.syncId!,
          variantId: destMovement.variantId,
          locationId: destMovement.locationId,
          batchSyncId: destBatch.syncId,
          quantityDelta: destMovement.quantityDelta,
          movementType: destMovement.movementType,
          referenceType: destMovement.referenceType,
        },
        destBatch: {
          syncId: destBatch.syncId!,
          variantId: destBatch.variantId,
          locationId: destBatch.locationId,
          lotNumber: destBatch.lotNumber,
          expiryDate: destBatch.expiryDate,
          quantity: destBatch.quantity,
          unitCost: destBatch.unitCost,
        },
      });
    };

    let toBreak = input.quantity;
    for (const { batch, remaining } of withRemaining) {
      if (toBreak <= 0) break;
      const take = Math.min(toBreak, remaining);
      if (take <= 0) continue;
      await openOne(take, batch);
      toBreak -= take;
    }
    // Reliquat sans lot (stock jamais suivi par lot).
    if (toBreak > 0) await openOne(toBreak, undefined);

    return buildSyncEvent<StockBreakdownCreatedEventPayload>("stockBreakdown.created", { unitsPerParent: units, legs });
  });

  emitSyncEvent(event);
  await logAction(db, {
    userId: input.userId ?? null,
    action: "stock_break_pack",
    entity: "stock",
    entityId: input.parentVariantId,
    metadata: {
      parentVariantId: input.parentVariantId,
      childVariantId: input.childVariantId,
      locationId: input.locationId,
      boxes: input.quantity,
      units: input.quantity * units,
    },
  });
}

export interface LotTraceBatch {
  batch: typeof schema.stockBatches.$inferSelect;
  productName: string;
  remaining: number;
  // Achat d'origine (si le lot en vient directement) et son fournisseur.
  purchaseNumber: string | null;
  supplierName: string | null;
}

export interface LotTraceSale {
  saleId: number;
  number: string;
  createdAt: string;
  productName: string;
  quantity: number;
  customerId: number | null;
  customerName: string | null;
  customerPhone: string | null;
}

export interface LotTrace {
  batches: LotTraceBatch[];
  sales: LotTraceSale[];
}

// Traçabilité d'un numéro de lot : où il se trouve, d'où il vient, à qui il a été
// vendu. Sert aux rappels de lot (prévenir les clients). Un lot ouvert en
// plaquettes garde son numéro : ses unités détaillées sont retrouvées aussi.
export async function getLotTrace(db: Database, lotNumber: string): Promise<LotTrace> {
  const wanted = lotNumber.trim().toLowerCase();
  if (!wanted) return { batches: [], sales: [] };

  const allBatches = await db.select().from(schema.stockBatches);
  const batches = allBatches.filter((b) => b.lotNumber?.trim().toLowerCase() === wanted);
  if (batches.length === 0) return { batches: [], sales: [] };
  const batchIds = batches.map((b) => b.id);

  const [remainingMap, variants, products, movements] = await Promise.all([
    getBatchRemainingMap(db, batchIds),
    db.select().from(schema.productVariants),
    db.select().from(schema.products),
    db.select().from(schema.stockMovements).where(inArray(schema.stockMovements.batchId, batchIds)),
  ]);
  const productNameOfVariant = (variantId: number) => {
    const variant = variants.find((v) => v.id === variantId);
    const name = products.find((p) => p.id === variant?.productId)?.name ?? `#${variantId}`;
    // Présentation détaillée : « Doliprane 500 (Plaquette) », pour la distinguer de la boîte.
    if (variant?.parentVariantId != null) {
      try {
        const presentation = (JSON.parse(variant.attributes ?? "{}") as { presentation?: string }).presentation;
        if (presentation) return `${name} (${presentation})`;
      } catch {
        // attributs illisibles : on garde le nom du produit
      }
    }
    return name;
  };

  const purchaseIds = [
    ...new Set(movements.filter((m) => m.movementType === "purchase" && m.referenceType === "purchase" && m.referenceId != null).map((m) => m.referenceId!)),
  ];
  const purchases = purchaseIds.length
    ? await db.select().from(schema.purchases).where(inArray(schema.purchases.id, purchaseIds))
    : [];
  const suppliers = await db.select().from(schema.suppliers);

  const traceBatches: LotTraceBatch[] = batches.map((batch) => {
    const purchaseId = movements.find((m) => m.batchId === batch.id && m.movementType === "purchase")?.referenceId;
    const purchase = purchases.find((p) => p.id === purchaseId);
    return {
      batch,
      productName: productNameOfVariant(batch.variantId),
      remaining: remainingMap.get(batch.id) ?? 0,
      purchaseNumber: purchase?.number ?? null,
      supplierName: suppliers.find((s) => s.id === purchase?.supplierId)?.name ?? null,
    };
  });

  // Ventes : quantité sortie de CE lot par vente.
  const soldBySale = new Map<number, { quantity: number; variantId: number }>();
  for (const m of movements) {
    if (m.movementType !== "sale" || m.referenceType !== "sale" || m.referenceId == null) continue;
    const entry = soldBySale.get(m.referenceId) ?? { quantity: 0, variantId: m.variantId };
    entry.quantity += -m.quantityDelta;
    soldBySale.set(m.referenceId, entry);
  }
  const saleIds = [...soldBySale.keys()];
  const sales = saleIds.length ? await db.select().from(schema.sales).where(inArray(schema.sales.id, saleIds)) : [];
  const customers = await db.select().from(schema.customers);

  const traceSales: LotTraceSale[] = sales
    .map((sale) => {
      const sold = soldBySale.get(sale.id)!;
      const customer = customers.find((c) => c.id === sale.customerId);
      return {
        saleId: sale.id,
        number: sale.number,
        createdAt: sale.createdAt,
        productName: productNameOfVariant(sold.variantId),
        quantity: sold.quantity,
        customerId: sale.customerId,
        customerName: customer?.fullName ?? null,
        customerPhone: customer?.phone ?? null,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { batches: traceBatches, sales: traceSales };
}

export interface EquivalentProduct {
  product: typeof schema.products.$inferSelect;
  // Stock vendable (toutes présentations de la boutique, hors lots périmés).
  sellableStock: number;
}

// Produits équivalents (même DCI et même dosage) à un produit donné, ceux qui ont
// du stock vendable d'abord — pour proposer une alternative en cas de rupture.
export async function findEquivalents(db: Database, productId: number, storeId?: number): Promise<EquivalentProduct[]> {
  const [products, variants, levels, expired] = await Promise.all([
    db.select().from(schema.products),
    db.select().from(schema.productVariants),
    getStockLevels(db, storeId),
    listExpiredBatches(db, storeId),
  ]);
  const source = products.find((p) => p.id === productId);
  if (!source) return [];

  const stockByVariant = new Map<number, number>();
  for (const level of levels) stockByVariant.set(level.variantId, (stockByVariant.get(level.variantId) ?? 0) + level.quantity);
  for (const e of expired) stockByVariant.set(e.variant.id, (stockByVariant.get(e.variant.id) ?? 0) - e.remaining);

  return products
    .filter((p) => p.id !== source.id && p.isActive && areEquivalent(source, p))
    .map((product) => ({
      product,
      sellableStock: Math.max(
        0,
        variants.filter((v) => v.productId === product.id).reduce((sum, v) => sum + (stockByVariant.get(v.id) ?? 0), 0),
      ),
    }))
    .sort((a, b) => Number(b.sellableStock > 0) - Number(a.sellableStock > 0) || a.product.salePrice - b.product.salePrice);
}

export interface ExpiringBatch {
  batch: typeof schema.stockBatches.$inferSelect;
  variant: typeof schema.productVariants.$inferSelect;
}

export async function listExpiringBatches(
  db: Database,
  withinDays: number,
  storeId?: number,
): Promise<ExpiringBatch[]> {
  const [allBatches, variants, storeLocationIds] = await Promise.all([
    db.select().from(schema.stockBatches),
    db.select().from(schema.productVariants),
    storeId ? locationIdsForStore(db, storeId) : Promise.resolve<number[] | null>(null),
  ]);
  const batches = storeLocationIds
    ? allBatches.filter((b) => storeLocationIds.includes(b.locationId))
    : allBatches;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + withinDays);
  const candidateBatches = batches.filter((b) => b.expiryDate && new Date(b.expiryDate) <= cutoff);

  // Précis par lot (et non plus au niveau du produit) maintenant que les
  // ventes/remboursements taguent chaque mouvement avec le bon batchId (voir
  // consumeStockFefo) — un lot épuisé disparaît de l'alerte même si d'autres
  // lots du même produit ont encore du stock.
  const remainingMap = await getBatchRemainingMap(db, candidateBatches.map((b) => b.id));

  const result: ExpiringBatch[] = [];
  for (const batch of candidateBatches) {
    if ((remainingMap.get(batch.id) ?? 0) <= 0) continue;
    const variant = variants.find((v) => v.id === batch.variantId);
    if (variant) result.push({ batch, variant });
  }
  return result;
}
