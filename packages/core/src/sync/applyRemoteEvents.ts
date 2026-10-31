import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { eq, sql } from "drizzle-orm";
import { uniqueSaleNumber } from "../services/documentNumber";
import { computeSaleItemTotal, computeTaxAmount } from "../services/SalesService";
import { applyApprovalRequestCreated, applyApprovalRequestDecided } from "../services/ApprovalRequestsService";
import { APPROVAL_GATED_EVENT_TYPES, assertWorkerEventApproved, isEventAlreadyApplied } from "./workerApproval";
import type {
  ApprovalRequestCreatedEventPayload,
  ApprovalRequestDecidedEventPayload,
  ExpenseCreatedEventPayload,
  SaleCreatedEventPayload,
  StockEntryCreatedEventPayload,
  StockBreakdownCreatedEventPayload,
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

// Le message est une fonction : le texte (traduit) n'est construit que si la vérification échoue.
function assertSync(condition: boolean, message: () => string): asserts condition {
  if (!condition) {
    throw new SyncValidationError(t("syncChecks.rejected", { message: message() }));
  }
}

function approxEqual(a: number, b: number, epsilon = AMOUNT_EPSILON): boolean {
  return Math.abs(a - b) <= epsilon;
}

async function assertUserExists(db: Database, userId: number): Promise<void> {
  const row = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).get();
  assertSync(!!row, () => t("syncChecks.userMissing", { userId }));
}

async function assertStoreExists(db: Database, storeId: number): Promise<void> {
  const row = await db.select({ id: schema.stores.id }).from(schema.stores).where(eq(schema.stores.id, storeId)).get();
  assertSync(!!row, () => t("syncChecks.storeMissing", { storeId }));
}

async function assertVariantExists(db: Database, variantId: number): Promise<void> {
  const row = await db
    .select({ id: schema.productVariants.id })
    .from(schema.productVariants)
    .where(eq(schema.productVariants.id, variantId))
    .get();
  assertSync(!!row, () => t("syncChecks.variantMissing", { variantId }));
}

async function assertLocationExists(db: Database, locationId: number): Promise<void> {
  const row = await db
    .select({ id: schema.stockLocations.id })
    .from(schema.stockLocations)
    .where(eq(schema.stockLocations.id, locationId))
    .get();
  assertSync(!!row, () => t("syncChecks.locationMissing", { locationId }));
}

async function resolveCustomerId(db: Database, syncId: string): Promise<number> {
  const row = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.syncId, syncId)).get();
  if (!row) {
    throw new Error(t("coreErrors.network.syncCustomerMissing", { syncId }));
  }
  return row.id;
}

async function resolveBatchId(db: Database, syncId: string): Promise<number> {
  const row = await db.select({ id: schema.stockBatches.id }).from(schema.stockBatches).where(eq(schema.stockBatches.syncId, syncId)).get();
  if (!row) {
    throw new Error(t("coreErrors.network.syncBatchMissing", { syncId }));
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
  assertSync(Number.isInteger(payload.sale.userId), () => t("syncChecks.saleUserInvalid"));
  await assertUserExists(db, payload.sale.userId);
  if (payload.sale.storeId != null) await assertStoreExists(db, payload.sale.storeId);
  assertSync(payload.items.length > 0, () => t("syncChecks.saleNoLine"));

  let itemsTotal = 0;
  let subtotal = 0;
  let taxTotal = 0;
  const consumedByVariant = new Map<number, number>();

  for (const item of payload.items) {
    assertSync(item.quantity > 0, () => t("syncChecks.quantityInvalid", { variantId: item.variantId }));
    assertSync(item.unitPrice >= 0, () => t("syncChecks.unitPriceInvalid", { variantId: item.variantId }));
    assertSync(item.discount >= 0, () => t("syncChecks.lineDiscountInvalid", { variantId: item.variantId }));
    await assertVariantExists(db, item.variantId);

    const expectedItemTotal = computeSaleItemTotal(item);
    assertSync(approxEqual(item.total, expectedItemTotal), () => t("syncChecks.lineTotalMismatch", { variantId: item.variantId }));

    subtotal += item.quantity * item.unitPrice;
    itemsTotal += expectedItemTotal;
    taxTotal += computeTaxAmount(expectedItemTotal, item.taxRate ?? 0);
    consumedByVariant.set(item.variantId, (consumedByVariant.get(item.variantId) ?? 0) + item.quantity);
  }

  assertSync(approxEqual(payload.sale.subtotal, subtotal), () => t("syncChecks.subtotalMismatch"));
  assertSync(approxEqual(payload.sale.taxTotal, taxTotal), () => t("syncChecks.taxMismatch"));
  assertSync(payload.sale.discount >= 0, () => t("syncChecks.discountNegative"));
  assertSync(payload.sale.discount <= itemsTotal + AMOUNT_EPSILON, () => t("syncChecks.discountTooHigh"));
  const expectedTotal = Math.max(0, itemsTotal - payload.sale.discount);
  assertSync(approxEqual(payload.sale.total, expectedTotal), () => t("syncChecks.saleTotalMismatch"));

  assertSync(payload.stockMovements.length > 0, () => t("syncChecks.saleNoMovement"));
  const movedByVariant = new Map<number, number>();
  for (const movement of payload.stockMovements) {
    assertSync(movement.movementType === "sale", () => t("syncChecks.saleMovementType"));
    assertSync(movement.quantityDelta < 0, () => t("syncChecks.saleMovementSign"));
    await assertVariantExists(db, movement.variantId);
    await assertLocationExists(db, movement.locationId);
    movedByVariant.set(movement.variantId, (movedByVariant.get(movement.variantId) ?? 0) - movement.quantityDelta);
  }
  for (const [variantId, quantity] of consumedByVariant) {
    assertSync(
      approxEqual(movedByVariant.get(variantId) ?? 0, quantity, 0.01),
      () => t("syncChecks.stockVsQuantity", { moved: movedByVariant.get(variantId) ?? 0, quantity, variantId }),
    );
  }

  if (payload.payment) {
    assertSync(payload.payment.amount > 0, () => t("syncChecks.paymentAmountInvalid"));
  }

  if (payload.credit) {
    assertSync(customerId != null, () => t("syncChecks.creditNoCustomer"));
    assertSync(payload.credit.originalAmount > 0, () => t("syncChecks.creditAmountInvalid"));
    assertSync(payload.credit.remainingBalance >= 0, () => t("syncChecks.creditBalanceNegative"));
    assertSync(payload.credit.remainingBalance <= payload.credit.originalAmount + AMOUNT_EPSILON, () => t("syncChecks.creditBalanceTooHigh"));
    const expectedCredit = expectedTotal - (payload.payment?.amount ?? 0);
    assertSync(approxEqual(payload.credit.originalAmount, expectedCredit), () => t("syncChecks.creditAmountMismatch"));
  }

  const settings = await db.select().from(schema.businessSettings).where(eq(schema.businessSettings.id, 1)).get();
  const ratio = settings?.loyaltyPointsRatio ?? 0;
  const maxMultiplier = Math.max(1, settings?.loyaltyTierSilverMultiplier ?? 1, settings?.loyaltyTierGoldMultiplier ?? 1);

  if (payload.loyaltyEarn) {
    assertSync(customerId != null, () => t("syncChecks.earnNoCustomer"));
    assertSync(payload.loyaltyEarn.pointsDelta > 0, () => t("syncChecks.earnNotPositive"));
    const bound = expectedTotal * ratio * maxMultiplier * LOYALTY_BOUND_SAFETY_FACTOR;
    assertSync(payload.loyaltyEarn.pointsDelta <= bound + AMOUNT_EPSILON, () => t("syncChecks.earnUnrelated"));
  }

  if (payload.loyaltyRedeem) {
    assertSync(customerId != null, () => t("syncChecks.redeemNoCustomer"));
    assertSync(payload.loyaltyRedeem.pointsDelta < 0, () => t("syncChecks.redeemMustReduce"));
    const customer = customerId != null ? await db.select().from(schema.customers).where(eq(schema.customers.id, customerId)).get() : undefined;
    assertSync(
      !!customer && Math.abs(payload.loyaltyRedeem.pointsDelta) <= customer.loyaltyPoints + AMOUNT_EPSILON,
      () => t("syncChecks.redeemOverBalance"),
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
      number: await uniqueSaleNumber(db, payload.sale.number, payload.sale.syncId),
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
      prescriptionRef: payload.sale.prescriptionRef ?? null,
      prescriber: payload.sale.prescriber ?? null,
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

  assertSync(payload.movement.movementType === "adjustment", () => t("syncChecks.entryMovementType"));
  assertSync(payload.movement.referenceType === "manual", () => t("syncChecks.entryReference"));
  assertSync(payload.movement.quantityDelta > 0, () => t("syncChecks.entrySign"));
  await assertVariantExists(db, payload.movement.variantId);
  await assertLocationExists(db, payload.movement.locationId);
  if (payload.batch) {
    assertSync(payload.batch.quantity > 0, () => t("syncChecks.batchQuantityInvalid"));
    assertSync(approxEqual(payload.batch.quantity, payload.movement.quantityDelta, 0.01), () => t("syncChecks.batchQuantityMismatch"));
    assertSync(payload.batch.variantId === payload.movement.variantId, () => t("syncChecks.batchVariantMismatch"));
    assertSync(payload.batch.locationId === payload.movement.locationId, () => t("syncChecks.batchLocationMismatch"));
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

  assertSync(payload.movement.movementType === "loss", () => t("syncChecks.lossMovementType"));
  assertSync(payload.movement.quantityDelta < 0, () => t("syncChecks.lossSign"));
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

    assertSync(leg.sourceMovement.movementType === "transfer", () => t("syncChecks.transferSourceType"));
    assertSync(leg.destMovement.movementType === "transfer", () => t("syncChecks.transferDestType"));
    assertSync(leg.sourceMovement.quantityDelta < 0, () => t("syncChecks.transferSourceSign"));
    assertSync(leg.destMovement.quantityDelta > 0, () => t("syncChecks.transferDestSign"));
    assertSync(
      approxEqual(-leg.sourceMovement.quantityDelta, leg.destMovement.quantityDelta, 0.01),
      () => t("syncChecks.transferQuantities"),
    );
    assertSync(leg.sourceMovement.variantId === leg.destMovement.variantId, () => t("syncChecks.transferVariantMismatch"));
    assertSync(leg.sourceMovement.locationId !== leg.destMovement.locationId, () => t("syncChecks.transferSameLocation"));
    await assertVariantExists(db, leg.sourceMovement.variantId);
    await assertLocationExists(db, leg.sourceMovement.locationId);
    await assertLocationExists(db, leg.destMovement.locationId);
    if (leg.destBatch) {
      assertSync(approxEqual(leg.destBatch.quantity, leg.destMovement.quantityDelta, 0.01), () => t("syncChecks.transferBatchQuantity"));
      assertSync(leg.destBatch.variantId === leg.destMovement.variantId, () => t("syncChecks.transferBatchVariant"));
      assertSync(leg.destBatch.locationId === leg.destMovement.locationId, () => t("syncChecks.transferBatchLocation"));
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

async function applyStockBreakdownCreated(db: Database, payload: StockBreakdownCreatedEventPayload): Promise<void> {
  assertSync(payload.unitsPerParent > 0, () => t("syncChecks.packUnitsInvalid"));
  for (const leg of payload.legs) {
    const existing = await db
      .select({ id: schema.stockMovements.id })
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.syncId, leg.sourceMovement.syncId))
      .get();
    if (existing) continue;

    assertSync(leg.sourceMovement.movementType === "adjustment" && leg.destMovement.movementType === "adjustment", () => t("syncChecks.packMovementType"));
    assertSync(leg.sourceMovement.quantityDelta < 0, () => t("syncChecks.packSourceSign"));
    assertSync(leg.destMovement.quantityDelta > 0, () => t("syncChecks.packDestSign"));
    assertSync(
      approxEqual(-leg.sourceMovement.quantityDelta * payload.unitsPerParent, leg.destMovement.quantityDelta, 0.01),
      () => t("syncChecks.packQuantities"),
    );
    assertSync(leg.sourceMovement.locationId === leg.destMovement.locationId, () => t("syncChecks.packSameLocation"));
    assertSync(leg.sourceMovement.variantId !== leg.destMovement.variantId, () => t("syncChecks.packTwoVariants"));
    await assertLocationExists(db, leg.sourceMovement.locationId);
    // Le lien boîte → détail doit exister dans le catalogue local, avec la même contenance.
    const child = await db
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, leg.destMovement.variantId))
      .get();
    assertSync(
      !!child && child.parentVariantId === leg.sourceMovement.variantId && approxEqual(child.unitsPerParent ?? 0, payload.unitsPerParent, 0.0001),
      () => t("syncChecks.packChildUnknown"),
    );
    assertSync(approxEqual(leg.destBatch.quantity, leg.destMovement.quantityDelta, 0.01), () => t("syncChecks.packBatchQuantity"));
    assertSync(leg.destBatch.variantId === leg.destMovement.variantId && leg.destBatch.locationId === leg.destMovement.locationId, () => t("syncChecks.packBatchMismatch"));

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
    await insertMovement(db, leg.sourceMovement, null);
    await insertMovement(db, leg.destMovement, null);
  }
}

async function applyExpenseCreated(db: Database, payload: ExpenseCreatedEventPayload): Promise<void> {
  const existing = await db.select({ id: schema.expenses.id }).from(schema.expenses).where(eq(schema.expenses.syncId, payload.expense.syncId)).get();
  if (existing) return;

  assertSync(payload.expense.amount > 0, () => t("syncChecks.expenseAmountInvalid"));
  assertSync(approxEqual(payload.expense.amount, payload.payment.amount), () => t("syncChecks.expensePaymentMismatch"));
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
// D'où vient l'événement : `master` (le Maître fait autorité, c'est le cas d'un
// appareil relié qui reçoit) ou `worker` (le Maître reçoit d'un appareil relié,
// qui n'est PAS cru sur parole).
export type SyncOrigin = "master" | "worker";

// Événements qu'un appareil relié n'a pas le droit d'émettre lui-même. Une
// décision d'approbation porte l'identité du décideur (`decidedBy`) en simple
// donnée : n'importe quel appareil connaissant le jeton de pairage pourrait donc
// se faire passer pour le propriétaire. Une décision venant d'un appareil relié
// doit passer par la preuve de PIN (message `approvalDecision`, voir
// decideApprovalRequestRemote) ; le Maître la rediffuse ensuite lui-même.
const FORBIDDEN_FROM_WORKER: ReadonlySet<SyncEvent["type"]> = new Set(["approvalRequest.decided"]);

export async function applyRemoteSyncEvent(
  db: Database,
  event: SyncEvent,
  origin: SyncOrigin = "master",
  // Responsable dont le Maître a lui-même vérifié le PIN pour cet appareil (voir approvalGrants.ts).
  verifiedApproverId: number | null = null,
): Promise<void> {
  if (origin === "worker" && FORBIDDEN_FROM_WORKER.has(event.type)) {
    throw new Error(t("coreErrors.auth.syncEventNotAllowed"));
  }
  // Une action qui dépassait un seuil doit prouver son approbation (le renvoi d'un événement déjà appliqué passe).
  if (origin === "worker" && APPROVAL_GATED_EVENT_TYPES.has(event.type) && !(await isEventAlreadyApplied(db, event))) {
    await assertWorkerEventApproved(db, event, verifiedApproverId);
  }
  switch (event.type) {
    case "sale.created":
      return applySaleCreated(db, event.payload as SaleCreatedEventPayload);
    case "stockEntry.created":
      return applyStockEntryCreated(db, event.payload as StockEntryCreatedEventPayload);
    case "stockLoss.created":
      return applyStockLossCreated(db, event.payload as StockLossCreatedEventPayload);
    case "stockTransfer.created":
      return applyStockTransferCreated(db, event.payload as StockTransferCreatedEventPayload);
    case "stockBreakdown.created":
      return applyStockBreakdownCreated(db, event.payload as StockBreakdownCreatedEventPayload);
    case "expense.created":
      return applyExpenseCreated(db, event.payload as ExpenseCreatedEventPayload);
    case "approvalRequest.created":
      return applyApprovalRequestCreated(db, event.payload as ApprovalRequestCreatedEventPayload);
    case "approvalRequest.decided":
      return applyApprovalRequestDecided(db, event.payload as ApprovalRequestDecidedEventPayload);
    default:
      // Un type inconnu était ignoré en silence, puis consigné et rediffusé à tous
      // les appareils comme s'il avait été appliqué.
      throw new Error(t("coreErrors.auth.syncEventUnknown"));
  }
}
