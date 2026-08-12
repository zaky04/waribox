import type { Database } from "@gestion-boutique/database";
import { schema, withTransaction } from "@gestion-boutique/database";
import { and, asc, eq } from "drizzle-orm";
import { logAction } from "./AuditService";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { recordMovement } from "./StockService";

// Répartit `amount` unités sur une liste de lots ordonnée (même ordre FEFO
// que consumeStockFefo, dérivé de l'ordre des mouvements de vente) en
// remplissant chaque lot à hauteur de sa quantité vendue avant de passer au
// suivant — reproduit exactement l'allocation que consumeStockFefo aurait
// faite, pour pouvoir la "rejouer" jusqu'à un certain montant cumulé.
export function allocateAcrossMagnitudes(
  magnitudes: { batchId: number | null; qty: number }[],
  amount: number,
): Map<string, number> {
  let remaining = amount;
  const result = new Map<string, number>();
  for (const m of magnitudes) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, m.qty);
    if (take > 0) result.set(String(m.batchId), take);
    remaining -= take;
  }
  return result;
}

// Quantité déjà remise en stock pour cette ligne de vente, tous
// remboursements confondus — sert de point de départ à la ré-allocation par
// lot (voir allocateAcrossMagnitudes) pour ne pas re-remettre en stock une
// quantité déjà restituée par un remboursement partiel précédent.
async function getTotalRestockedForSaleItem(db: Database, saleItemId: number): Promise<number> {
  const rows = await db
    .select({ quantity: schema.refundItems.quantity })
    .from(schema.refundItems)
    .where(and(eq(schema.refundItems.saleItemId, saleItemId), eq(schema.refundItems.restocked, true)));
  return rows.reduce((sum, r) => sum + r.quantity, 0);
}

export type RefundMethod = "cash" | "card" | "mobile_money";

export interface RefundItemInput {
  saleItemId: number;
  quantity: number;
  // Remet la quantité en stock vendable (recordMovement "return") — à
  // décocher pour un article rendu défectueux/détruit, qui ne doit pas
  // repartir en rayon.
  restock: boolean;
}

export interface CreateRefundInput {
  saleId: number;
  items: RefundItemInput[];
  reason?: string;
  method: RefundMethod;
  userId: number;
}

// Total déjà remboursé par ligne de vente, toutes remboursements confondus
// (un article peut être rendu en plusieurs fois) — utilisé pour plafonner la
// quantité remboursable et éviter un double remboursement.
export async function getRefundedQuantities(db: Database, saleId: number): Promise<Record<number, number>> {
  const items = await db
    .select({ saleItemId: schema.saleItems.id })
    .from(schema.saleItems)
    .where(eq(schema.saleItems.saleId, saleId));
  const saleItemIds = new Set(items.map((i) => i.saleItemId));
  if (saleItemIds.size === 0) return {};

  const refundRows = await db
    .select({ saleItemId: schema.refundItems.saleItemId, quantity: schema.refundItems.quantity })
    .from(schema.refundItems)
    .innerJoin(schema.refunds, eq(schema.refundItems.refundId, schema.refunds.id))
    .where(eq(schema.refunds.saleId, saleId));

  const result: Record<number, number> = {};
  for (const row of refundRows) {
    if (!saleItemIds.has(row.saleItemId)) continue;
    result[row.saleItemId] = (result[row.saleItemId] ?? 0) + row.quantity;
  }
  return result;
}

export async function createRefund(db: Database, input: CreateRefundInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_refunds");

  if (input.items.length === 0) {
    throw new Error("Sélectionne au moins un article à rembourser.");
  }

  // Toute la séquence lecture-validation-écriture est atomique (voir
  // withTransaction dans SalesService.createSale pour le même raisonnement) —
  // sinon deux remboursements concurrents sur la même ligne de vente
  // pourraient tous deux valider la même quantité restante avant qu'aucun
  // n'écrive, causant un double remboursement.
  return withTransaction(() => createRefundInTransaction(db, input));
}

async function createRefundInTransaction(db: Database, input: CreateRefundInput) {
  const sale = await db.select().from(schema.sales).where(eq(schema.sales.id, input.saleId)).get();
  if (!sale) {
    throw new Error("Vente introuvable.");
  }

  const saleItems = await db
    .select()
    .from(schema.saleItems)
    .where(eq(schema.saleItems.saleId, input.saleId));
  const saleItemById = new Map(saleItems.map((i) => [i.id, i]));

  const alreadyRefunded = await getRefundedQuantities(db, input.saleId);

  let subtotal = 0;
  let taxTotal = 0;
  let total = 0;
  const lines: { saleItemId: number; quantity: number; unitPrice: number; taxRate: number; total: number; restock: boolean; variantId: number }[] = [];

  for (const requested of input.items) {
    if (requested.quantity <= 0) continue;
    const saleItem = saleItemById.get(requested.saleItemId);
    if (!saleItem) {
      throw new Error("Article de vente introuvable pour cette vente.");
    }
    const refundedSoFar = alreadyRefunded[saleItem.id] ?? 0;
    const remaining = saleItem.quantity - refundedSoFar;
    if (requested.quantity > remaining) {
      throw new Error(
        `Quantité remboursable dépassée pour cet article (restant : ${remaining}, demandé : ${requested.quantity}).`,
      );
    }

    // Prorata sur le total déjà stocké de la ligne (TTC, remise incluse)
    // plutôt que quantité×prix unitaire — évite de recalculer/dupliquer la
    // logique de remise appliquée à la vente d'origine.
    const fraction = requested.quantity / saleItem.quantity;
    const lineTotal = saleItem.total * fraction;
    const lineTax = lineTotal > 0 ? lineTotal * (saleItem.taxRate / (100 + saleItem.taxRate)) : 0;

    subtotal += saleItem.unitPrice * requested.quantity;
    taxTotal += saleItem.taxRate > 0 ? lineTax : 0;
    total += lineTotal;

    lines.push({
      saleItemId: saleItem.id,
      quantity: requested.quantity,
      unitPrice: saleItem.unitPrice,
      taxRate: saleItem.taxRate,
      total: lineTotal,
      restock: requested.restock,
      variantId: saleItem.variantId,
    });
  }

  if (lines.length === 0) {
    throw new Error("Aucune quantité valide à rembourser.");
  }

  const refund = await db
    .insert(schema.refunds)
    .values({
      saleId: input.saleId,
      userId: input.userId,
      reason: input.reason,
      method: input.method,
      subtotal,
      taxTotal,
      total,
    })
    .returning()
    .get();

  for (const line of lines) {
    // Calculé avant l'insertion de la ligne de remboursement ci-dessous,
    // qui porte déjà `restocked: line.restock` — sinon cette ligne se
    // compterait elle-même dans son propre "déjà restitué".
    const priorRestocked = line.restock ? await getTotalRestockedForSaleItem(db, line.saleItemId) : 0;

    await db.insert(schema.refundItems).values({
      refundId: refund.id,
      saleItemId: line.saleItemId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxRate: line.taxRate,
      total: line.total,
      restocked: line.restock,
    });

    if (line.restock) {
      // Retrouve les mouvements de sortie de la vente initiale pour cet
      // article — un article peut avoir été prélevé sur plusieurs lots
      // (FEFO, voir consumeStockFefo). On rejoue la même allocation
      // ordonnée pour déterminer, lot par lot, la quantité déjà restituée
      // par un remboursement précédent (priorAllocation) et celle qui doit
      // l'être après ce remboursement (newAllocation) — la différence est
      // ce qu'on remet en stock ici, taguée avec le bon batchId.
      const saleMovements = await db
        .select()
        .from(schema.stockMovements)
        .where(
          and(
            eq(schema.stockMovements.referenceType, "sale"),
            eq(schema.stockMovements.referenceId, input.saleId),
            eq(schema.stockMovements.variantId, line.variantId),
            eq(schema.stockMovements.movementType, "sale"),
          ),
        )
        .orderBy(asc(schema.stockMovements.id));
      const firstMovement = saleMovements[0];
      if (!firstMovement) {
        throw new Error("Impossible de retrouver l'emplacement d'origine de cet article pour la remise en stock.");
      }
      const locationId = firstMovement.locationId;
      const magnitudes = saleMovements.map((m) => ({ batchId: m.batchId, qty: -m.quantityDelta }));
      const priorAllocation = allocateAcrossMagnitudes(magnitudes, priorRestocked);
      const newAllocation = allocateAcrossMagnitudes(magnitudes, priorRestocked + line.quantity);
      for (const m of magnitudes) {
        const before = priorAllocation.get(String(m.batchId)) ?? 0;
        const after = newAllocation.get(String(m.batchId)) ?? 0;
        const delta = after - before;
        if (delta <= 0) continue;
        await recordMovement(db, {
          variantId: line.variantId,
          locationId,
          quantityDelta: delta,
          movementType: "return",
          referenceType: "refund",
          referenceId: refund.id,
          batchId: m.batchId ?? undefined,
          userId: input.userId,
        });
      }
    }
  }

  if (total > 0) {
    await db.insert(schema.payments).values({
      referenceType: "refund",
      referenceId: refund.id,
      method: input.method,
      amount: total,
      receivedBy: input.userId,
      storeId: sale.storeId,
    });
  }

  // Marque la vente comme intégralement remboursée seulement si la somme de
  // tous ses remboursements (celui-ci inclus) couvre son total — un
  // remboursement partiel laisse le statut 'completed' (pas de valeur dédiée
  // dans le schéma pour "partiellement remboursé").
  const refundedTotals = await db
    .select({ total: schema.refunds.total })
    .from(schema.refunds)
    .where(eq(schema.refunds.saleId, input.saleId));
  const totalRefunded = refundedTotals.reduce((sum, r) => sum + r.total, 0);
  if (totalRefunded >= sale.total) {
    await db.update(schema.sales).set({ status: "refunded" }).where(eq(schema.sales.id, input.saleId)).run();
  }

  await logAction(db, {
    userId: input.userId,
    action: "create_refund",
    entity: "refund",
    entityId: refund.id,
    metadata: { saleNumber: sale.number, total, reason: input.reason },
  });

  return refund;
}

export async function listRefundsForSale(db: Database, saleId: number) {
  return db.select().from(schema.refunds).where(eq(schema.refunds.saleId, saleId));
}

// Total remboursé par vente, toutes ventes confondues — utilisé par la liste
// des ventes (Journaux) pour distinguer une vente non remboursée, partielle
// ou totale sans lancer une requête par ligne.
export async function getRefundTotalsBySale(db: Database): Promise<Record<number, number>> {
  const rows = await db
    .select({ saleId: schema.refunds.saleId, total: schema.refunds.total })
    .from(schema.refunds);

  const result: Record<number, number> = {};
  for (const row of rows) {
    result[row.saleId] = (result[row.saleId] ?? 0) + row.total;
  }
  return result;
}

export async function listRefundItems(db: Database, refundId: number) {
  return db.select().from(schema.refundItems).where(eq(schema.refundItems.refundId, refundId));
}
