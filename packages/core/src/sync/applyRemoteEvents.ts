import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq, sql } from "drizzle-orm";
import { computeSaleItemTotal, computeTaxAmount } from "../services/SalesService";
import type {
  ExpenseCreatedEventPayload,
  SaleCreatedEventPayload,
  StockEntryCreatedEventPayload,
  StockLossCreatedEventPayload,
  StockTransferCreatedEventPayload,
  SyncEvent,
  SyncStockMovementPayload,
} from "./syncEvents";

// Applique un événement reçu (Master qui reçoit d'un Worker, ou Worker qui
// reçoit du Master) à la base locale de CET appareil — voir CLAUDE.md, mode
// réseau Phase 2. Contrairement aux fonctions de service normales
// (createSale, etc.), ces fonctions ne vérifient AUCUNE permission : la
// confiance vient du jeton de pairage déjà validé à la connexion (voir
// Phase 1), pas d'une nouvelle autorisation par événement — l'appareil
// d'origine a déjà appliqué ses propres règles métier (stock suffisant,
// permission de l'utilisateur...) avant de produire cet événement ; le
// rejouer ici ne fait que reproduire un fait déjà validé, jamais une
// nouvelle décision.
//
// En revanche, "aucune permission" ne veut pas dire "aucune validation" :
// une fois le jeton de pairage connu (compromission d'un Worker, capture
// réseau...), n'importe quel client WebSocket pourrait forger une trame
// `sync` directement, sans jamais passer par createSale/etc. — voir l'audit
// de sécurité du 2026-09-07. Chaque fonction ci-dessous revalide donc les
// invariants structurels et financiers de son événement (totaux recalculés
// à partir des lignes, bornes sur les points de fidélité, signe des
// mouvements de stock, existence locale des id de catalogue référencés)
// avant d'écrire quoi que ce soit — pas une ré-autorisation métier complète
// (impossible sans rejouer tout createSale), mais assez pour qu'un événement
// forgé ne puisse plus créer de valeur (points, remise, stock) à partir de
// rien. Une marge de tolérance (epsilon sur les montants, facteur de
// sécurité sur les points) absorbe l'arrondi flottant et le fait que les
// paramètres locaux (ratio de fidélité...) peuvent être temporairement en
// retard sur le Master tant que la Phase 3 (sync continue du catalogue)
// n'existe pas — voir CLAUDE.md.
//
// Idempotence : chaque fonction vérifie d'abord si la ligne racine de
// l'événement (identifiée par son syncId) existe déjà localement — si oui,
// l'événement est ignoré silencieusement. Nécessaire car un Worker qui se
// reconnecte peut recevoir en double un événement déjà appliqué.

// Tolérance flottante sur les montants (arrondi, devises sans décimale) —
// volontairement pas 0 : deux appareils qui recalculent le même montant à
// partir des mêmes lignes peuvent différer de quelques centièmes.
const AMOUNT_EPSILON = 0.02;
// Marge appliquée aux bornes de points de fidélité — tolère un ratio/
// multiplicateur local en retard sur le Master (pas de sync continue des
// paramètres avant la Phase 3) sans pour autant laisser passer un montant
// de points sans rapport avec la vente (voir le commentaire en tête de
// fichier).
const LOYALTY_BOUND_SAFETY_FACTOR = 3;

class SyncValidationError extends Error {}

function assertSync(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new SyncValidationError(`Sync: événement rejeté — ${message}`);
  }
}

function approxEqual(a: number, b: number, epsilon = AMOUNT_EPSILON): boolean {
  return Math.abs(a - b) <= epsilon;
}

async function assertUserExists(db: Database, userId: number): Promise<void> {
  const row = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).get();
  assertSync(!!row, `utilisateur ${userId} introuvable localement`);
}

async function assertStoreExists(db: Database, storeId: number): Promise<void> {
  const row = await db.select({ id: schema.stores.id }).from(schema.stores).where(eq(schema.stores.id, storeId)).get();
  assertSync(!!row, `boutique ${storeId} introuvable localement`);
}

async function assertVariantExists(db: Database, variantId: number): Promise<void> {
  const row = await db
    .select({ id: schema.productVariants.id })
    .from(schema.productVariants)
    .where(eq(schema.productVariants.id, variantId))
    .get();
  assertSync(!!row, `variante ${variantId} introuvable localement`);
}

async function assertLocationExists(db: Database, locationId: number): Promise<void> {
  const row = await db
    .select({ id: schema.stockLocations.id })
    .from(schema.stockLocations)
    .where(eq(schema.stockLocations.id, locationId))
    .get();
  assertSync(!!row, `emplacement de stock ${locationId} introuvable localement`);
}

async function resolveCustomerId(db: Database, syncId: string): Promise<number> {
  const row = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.syncId, syncId)).get();
  if (!row) {
    throw new Error(`Sync: client introuvable pour syncId ${syncId} — événement reçu hors ordre ?`);
  }
  return row.id;
}

async function resolveBatchId(db: Database, syncId: string): Promise<number> {
  const row = await db.select({ id: schema.stockBatches.id }).from(schema.stockBatches).where(eq(schema.stockBatches.syncId, syncId)).get();
  if (!row) {
    throw new Error(`Sync: lot de stock introuvable pour syncId ${syncId} — événement reçu hors ordre ?`);
  }
  return row.id;
}

async function insertMovement(
  db: Database,
  payload: SyncStockMovementPayload,
  referenceId: number | null,
): Promise<void> {
  const batchId = payload.batchSyncId ? await resolveBatchId(db, payload.batchSyncId) : null;
  await db.insert(schema.stockMovements).values({
    syncId: payload.syncId,
    variantId: payload.variantId,
    locationId: payload.locationId,
    batchId,
    quantityDelta: payload.quantityDelta,
    movementType: payload.movementType as (typeof schema.stockMovements.$inferInsert)["movementType"],
    referenceType: payload.referenceType,
    referenceId,
  });
}

/**
 * Revalide les invariants financiers/structurels d'une vente reçue avant
 * toute écriture — voir le commentaire en tête de fichier. `customerId` est
 * `null` pour une vente sans client (client de passage anonyme), auquel cas
 * `credit`/`loyaltyRedeem`/`loyaltyEarn` ne doivent pas être présents (même
 * contrainte que côté émetteur, voir SalesService.createSale).
 */
async function validateSaleCreated(db: Database, payload: SaleCreatedEventPayload, customerId: number | null): Promise<void> {
  assertSync(Number.isInteger(payload.sale.userId), "userId de vente manquant/invalide");
  await assertUserExists(db, payload.sale.userId);
  if (payload.sale.storeId != null) await assertStoreExists(db, payload.sale.storeId);
  assertSync(payload.items.length > 0, "vente sans ligne");

  let itemsTotal = 0;
  let subtotal = 0;
  let taxTotal = 0;
  const consumedByVariant = new Map<number, number>();

  for (const item of payload.items) {
    assertSync(item.quantity > 0, `quantité invalide pour la variante ${item.variantId}`);
    assertSync(item.unitPrice >= 0, `prix unitaire invalide pour la variante ${item.variantId}`);
    assertSync(item.discount >= 0, `remise de ligne invalide pour la variante ${item.variantId}`);
    await assertVariantExists(db, item.variantId);

    const expectedItemTotal = computeSaleItemTotal(item);
    assertSync(approxEqual(item.total, expectedItemTotal), `total de ligne incohérent pour la variante ${item.variantId}`);

    subtotal += item.quantity * item.unitPrice;
    itemsTotal += expectedItemTotal;
    taxTotal += computeTaxAmount(expectedItemTotal, item.taxRate ?? 0);
    consumedByVariant.set(item.variantId, (consumedByVariant.get(item.variantId) ?? 0) + item.quantity);
  }

  assertSync(approxEqual(payload.sale.subtotal, subtotal), "sous-total incohérent avec les lignes");
  assertSync(approxEqual(payload.sale.taxTotal, taxTotal), "TVA incohérente avec les lignes");
  assertSync(payload.sale.discount >= 0, "remise globale négative");
  assertSync(payload.sale.discount <= itemsTotal + AMOUNT_EPSILON, "remise supérieure au total des lignes");
  const expectedTotal = Math.max(0, itemsTotal - payload.sale.discount);
  assertSync(approxEqual(payload.sale.total, expectedTotal), "total de vente incohérent avec les lignes");

  assertSync(payload.stockMovements.length > 0, "vente sans mouvement de stock associé");
  const movedByVariant = new Map<number, number>();
  for (const movement of payload.stockMovements) {
    assertSync(movement.movementType === "sale", "type de mouvement inattendu pour une vente");
    assertSync(movement.quantityDelta < 0, "un mouvement de vente doit décrémenter le stock");
    await assertVariantExists(db, movement.variantId);
    await assertLocationExists(db, movement.locationId);
    movedByVariant.set(movement.variantId, (movedByVariant.get(movement.variantId) ?? 0) - movement.quantityDelta);
  }
  for (const [variantId, quantity] of consumedByVariant) {
    assertSync(
      approxEqual(movedByVariant.get(variantId) ?? 0, quantity, 0.01),
      `stock décrémenté (${movedByVariant.get(variantId) ?? 0}) incohérent avec la quantité vendue (${quantity}) pour la variante ${variantId}`,
    );
  }

  if (payload.payment) {
    assertSync(payload.payment.amount > 0, "montant de paiement invalide");
  }

  if (payload.credit) {
    assertSync(customerId != null, "créance sans client résolu");
    assertSync(payload.credit.originalAmount > 0, "montant de créance invalide");
    assertSync(payload.credit.remainingBalance >= 0, "solde de créance négatif");
    assertSync(payload.credit.remainingBalance <= payload.credit.originalAmount + AMOUNT_EPSILON, "solde de créance supérieur au montant d'origine");
    const expectedCredit = expectedTotal - (payload.payment?.amount ?? 0);
    assertSync(approxEqual(payload.credit.originalAmount, expectedCredit), "montant de créance incohérent avec le total payé");
  }

  const settings = await db.select().from(schema.businessSettings).where(eq(schema.businessSettings.id, 1)).get();
  const ratio = settings?.loyaltyPointsRatio ?? 0;
  const maxMultiplier = Math.max(1, settings?.loyaltyTierSilverMultiplier ?? 1, settings?.loyaltyTierGoldMultiplier ?? 1);

  if (payload.loyaltyEarn) {
    assertSync(customerId != null, "points gagnés sans client résolu");
    assertSync(payload.loyaltyEarn.pointsDelta > 0, "points gagnés non positifs");
    const bound = expectedTotal * ratio * maxMultiplier * LOYALTY_BOUND_SAFETY_FACTOR;
    assertSync(payload.loyaltyEarn.pointsDelta <= bound + AMOUNT_EPSILON, "points gagnés sans rapport avec le montant de la vente");
  }

  if (payload.loyaltyRedeem) {
    assertSync(customerId != null, "points rachetés sans client résolu");
    assertSync(payload.loyaltyRedeem.pointsDelta < 0, "points rachetés doivent réduire le solde");
    const customer = customerId != null ? await db.select().from(schema.customers).where(eq(schema.customers.id, customerId)).get() : undefined;
    assertSync(
      !!customer && Math.abs(payload.loyaltyRedeem.pointsDelta) <= customer.loyaltyPoints + AMOUNT_EPSILON,
      "points rachetés supérieurs au solde actuel du client",
    );
  }
}

async function applySaleCreated(db: Database, payload: SaleCreatedEventPayload): Promise<void> {
  const existing = await db.select({ id: schema.sales.id }).from(schema.sales).where(eq(schema.sales.syncId, payload.sale.syncId)).get();
  if (existing) return;

  let customerId: number | null = null;
  if (payload.newCustomer) {
    const existingCustomer = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.syncId, payload.newCustomer.syncId))
      .get();
    customerId = existingCustomer
      ? existingCustomer.id
      : (
          await db
            .insert(schema.customers)
            .values({ syncId: payload.newCustomer.syncId, fullName: payload.newCustomer.fullName })
            .returning()
            .get()
        ).id;
  } else if (payload.sale.customerSyncId) {
    customerId = await resolveCustomerId(db, payload.sale.customerSyncId);
  }

  await validateSaleCreated(db, payload, customerId);

  const sale = await db
    .insert(schema.sales)
    .values({
      syncId: payload.sale.syncId,
      number: payload.sale.number,
      customerId,
      userId: payload.sale.userId,
      storeId: payload.sale.storeId,
      saleMode: payload.sale.saleMode,
      subtotal: payload.sale.subtotal,
      discount: payload.sale.discount,
      taxTotal: payload.sale.taxTotal,
      total: payload.sale.total,
      paymentStatus: payload.sale.paymentStatus,
      createdAt: payload.sale.createdAt,
    })
    .returning()
    .get();

  for (const item of payload.items) {
    await db.insert(schema.saleItems).values({
      syncId: item.syncId,
      saleId: sale.id,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discount: item.discount,
      taxRate: item.taxRate,
      total: item.total,
    });
  }

  for (const movement of payload.stockMovements) {
    await insertMovement(db, movement, sale.id);
  }

  if (payload.payment) {
    await db.insert(schema.payments).values({
      syncId: payload.payment.syncId,
      referenceType: "sale",
      referenceId: sale.id,
      method: payload.payment.method,
      amount: payload.payment.amount,
      storeId: payload.payment.storeId,
    });
  }

  if (payload.credit && customerId != null) {
    await db.insert(schema.customerCredits).values({
      syncId: payload.credit.syncId,
      customerId,
      saleId: sale.id,
      storeId: payload.credit.storeId,
      originalAmount: payload.credit.originalAmount,
      remainingBalance: payload.credit.remainingBalance,
      status: "open",
    });
  }

  if (payload.loyaltyRedeem && customerId != null) {
    await db.insert(schema.loyaltyTransactions).values({
      syncId: payload.loyaltyRedeem.syncId,
      customerId,
      pointsDelta: payload.loyaltyRedeem.pointsDelta,
      reason: "redemption",
      referenceId: sale.id,
    });
    await db
      .update(schema.customers)
      .set({ loyaltyPoints: sql`${schema.customers.loyaltyPoints} + ${payload.loyaltyRedeem.pointsDelta}` })
      .where(eq(schema.customers.id, customerId))
      .run();
  }

  if (payload.loyaltyEarn && customerId != null) {
    await db.insert(schema.loyaltyTransactions).values({
      syncId: payload.loyaltyEarn.syncId,
      customerId,
      pointsDelta: payload.loyaltyEarn.pointsDelta,
      reason: "purchase",
      referenceId: sale.id,
    });
    await db
      .update(schema.customers)
      .set({
        loyaltyPoints: sql`${schema.customers.loyaltyPoints} + ${payload.loyaltyEarn.pointsDelta}`,
        lifetimeLoyaltyPoints: sql`${schema.customers.lifetimeLoyaltyPoints} + ${payload.loyaltyEarn.pointsDelta}`,
      })
      .where(eq(schema.customers.id, customerId))
      .run();
  }
}

async function applyStockEntryCreated(db: Database, payload: StockEntryCreatedEventPayload): Promise<void> {
  const existing = await db
    .select({ id: schema.stockMovements.id })
    .from(schema.stockMovements)
    .where(eq(schema.stockMovements.syncId, payload.movement.syncId))
    .get();
  if (existing) return;

  assertSync(payload.movement.movementType === "adjustment", "type de mouvement inattendu pour une entrée de stock");
  assertSync(payload.movement.referenceType === "manual", "référence inattendue pour une entrée de stock manuelle");
  assertSync(payload.movement.quantityDelta > 0, "une entrée de stock doit incrémenter le stock");
  await assertVariantExists(db, payload.movement.variantId);
  await assertLocationExists(db, payload.movement.locationId);
  if (payload.batch) {
    assertSync(payload.batch.quantity > 0, "quantité de lot invalide");
    assertSync(approxEqual(payload.batch.quantity, payload.movement.quantityDelta, 0.01), "quantité de lot incohérente avec le mouvement");
    assertSync(payload.batch.variantId === payload.movement.variantId, "variante de lot incohérente avec le mouvement");
    assertSync(payload.batch.locationId === payload.movement.locationId, "emplacement de lot incohérent avec le mouvement");
  }

  if (payload.batch) {
    const existingBatch = await db
      .select({ id: schema.stockBatches.id })
      .from(schema.stockBatches)
      .where(eq(schema.stockBatches.syncId, payload.batch.syncId))
      .get();
    if (!existingBatch) {
      await db.insert(schema.stockBatches).values({
        syncId: payload.batch.syncId,
        variantId: payload.batch.variantId,
        locationId: payload.batch.locationId,
        lotNumber: payload.batch.lotNumber,
        expiryDate: payload.batch.expiryDate,
        quantity: payload.batch.quantity,
      });
    }
  }

  await insertMovement(db, payload.movement, null);
}

async function applyStockLossCreated(db: Database, payload: StockLossCreatedEventPayload): Promise<void> {
  const existing = await db
    .select({ id: schema.stockMovements.id })
    .from(schema.stockMovements)
    .where(eq(schema.stockMovements.syncId, payload.movement.syncId))
    .get();
  if (existing) return;

  assertSync(payload.movement.movementType === "loss", "type de mouvement inattendu pour une perte de stock");
  assertSync(payload.movement.quantityDelta < 0, "une perte de stock doit décrémenter le stock");
  await assertVariantExists(db, payload.movement.variantId);
  await assertLocationExists(db, payload.movement.locationId);

  await insertMovement(db, payload.movement, null);
}

async function applyStockTransferCreated(db: Database, payload: StockTransferCreatedEventPayload): Promise<void> {
  for (const leg of payload.legs) {
    const existing = await db
      .select({ id: schema.stockMovements.id })
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.syncId, leg.sourceMovement.syncId))
      .get();
    if (existing) continue;

    assertSync(leg.sourceMovement.movementType === "transfer", "type de mouvement inattendu pour la source d'un transfert");
    assertSync(leg.destMovement.movementType === "transfer", "type de mouvement inattendu pour la destination d'un transfert");
    assertSync(leg.sourceMovement.quantityDelta < 0, "la source d'un transfert doit décrémenter le stock");
    assertSync(leg.destMovement.quantityDelta > 0, "la destination d'un transfert doit incrémenter le stock");
    assertSync(
      approxEqual(-leg.sourceMovement.quantityDelta, leg.destMovement.quantityDelta, 0.01),
      "quantités de transfert incohérentes entre source et destination",
    );
    assertSync(leg.sourceMovement.variantId === leg.destMovement.variantId, "variante incohérente entre source et destination du transfert");
    assertSync(leg.sourceMovement.locationId !== leg.destMovement.locationId, "un transfert doit changer d'emplacement");
    await assertVariantExists(db, leg.sourceMovement.variantId);
    await assertLocationExists(db, leg.sourceMovement.locationId);
    await assertLocationExists(db, leg.destMovement.locationId);
    if (leg.destBatch) {
      assertSync(approxEqual(leg.destBatch.quantity, leg.destMovement.quantityDelta, 0.01), "quantité de lot de destination incohérente avec le mouvement");
      assertSync(leg.destBatch.variantId === leg.destMovement.variantId, "variante de lot de destination incohérente");
      assertSync(leg.destBatch.locationId === leg.destMovement.locationId, "emplacement de lot de destination incohérent");
    }

    if (leg.destBatch) {
      const existingBatch = await db
        .select({ id: schema.stockBatches.id })
        .from(schema.stockBatches)
        .where(eq(schema.stockBatches.syncId, leg.destBatch.syncId))
        .get();
      if (!existingBatch) {
        await db.insert(schema.stockBatches).values({
          syncId: leg.destBatch.syncId,
          variantId: leg.destBatch.variantId,
          locationId: leg.destBatch.locationId,
          lotNumber: leg.destBatch.lotNumber,
          expiryDate: leg.destBatch.expiryDate,
          quantity: leg.destBatch.quantity,
          unitCost: leg.destBatch.unitCost,
        });
      }
    }

    await insertMovement(db, leg.sourceMovement, null);
    await insertMovement(db, leg.destMovement, null);
  }
}

async function applyExpenseCreated(db: Database, payload: ExpenseCreatedEventPayload): Promise<void> {
  const existing = await db.select({ id: schema.expenses.id }).from(schema.expenses).where(eq(schema.expenses.syncId, payload.expense.syncId)).get();
  if (existing) return;

  assertSync(payload.expense.amount > 0, "montant de dépense invalide");
  assertSync(approxEqual(payload.expense.amount, payload.payment.amount), "paiement miroir incohérent avec la dépense");
  if (payload.expense.userId != null) await assertUserExists(db, payload.expense.userId);
  if (payload.expense.storeId != null) await assertStoreExists(db, payload.expense.storeId);

  const expense = await db
    .insert(schema.expenses)
    .values({
      syncId: payload.expense.syncId,
      category: payload.expense.category,
      amount: payload.expense.amount,
      expenseDate: payload.expense.expenseDate,
      note: payload.expense.note,
      paymentMethod: payload.expense.paymentMethod,
      userId: payload.expense.userId,
      storeId: payload.expense.storeId,
    })
    .returning()
    .get();

  await db.insert(schema.payments).values({
    syncId: payload.payment.syncId,
    referenceType: "expense",
    referenceId: expense.id,
    method: payload.payment.method,
    amount: payload.payment.amount,
    storeId: payload.payment.storeId,
    createdAt: payload.payment.createdAt,
  });
}

/**
 * Point d'entrée unique : applique un `SyncEvent` reçu du réseau à la base
 * locale, quel que soit son type. Doit être appelé à l'intérieur d'une
 * transaction (voir `withTransaction`) par l'appelant réseau — cette
 * fonction ne l'ouvre pas elle-même, pour rester composable si plusieurs
 * événements du même lot de rattrapage doivent un jour être appliqués
 * ensemble. Un rejet de validation (voir `assertSync` ci-dessus) lève
 * simplement une erreur : c'est la transaction ouverte par l'appelant qui
 * annule tout ce que cette fonction avait déjà écrit.
 */
export async function applyRemoteSyncEvent(db: Database, event: SyncEvent): Promise<void> {
  switch (event.type) {
    case "sale.created":
      return applySaleCreated(db, event.payload as SaleCreatedEventPayload);
    case "stockEntry.created":
      return applyStockEntryCreated(db, event.payload as StockEntryCreatedEventPayload);
    case "stockLoss.created":
      return applyStockLossCreated(db, event.payload as StockLossCreatedEventPayload);
    case "stockTransfer.created":
      return applyStockTransferCreated(db, event.payload as StockTransferCreatedEventPayload);
    case "expense.created":
      return applyExpenseCreated(db, event.payload as ExpenseCreatedEventPayload);
  }
}
