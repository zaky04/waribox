import { roundMoney } from "../domain/money";
import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { and, desc, eq, gte, inArray, like, lte, sql } from "drizzle-orm";
import { withTransaction } from "@gestion-boutique/database";
import { logAction } from "./AuditService";
import { findOrCreateCustomerByName } from "./CustomersService";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { checkApproval, checkCreditApproval, computeUnauthorizedDiscount, verifyApprovalInput, type ApprovalInput } from "./ApprovalService";
import { getActivePromotionsWithProducts } from "./PromotionsService";
import { earnPoints, pointsToDiscount, redeemPoints } from "./LoyaltyService";
import { getSettings } from "./SettingsService";
import { assertValidAmount, assertValidLines } from "../domain/validation";
import { nextDocumentNumber } from "./documentNumber";
import { ExpiredStockError, todayISO } from "../domain/expiry";
import { missingPrescription } from "../domain/pharmacy";
import { consumeStockFefo, getSellableQuantity } from "./StockService";
import { buildSyncEvent, emitSyncEvent, type SaleCreatedEventPayload, type SyncStockMovementPayload } from "../sync/syncEvents";
import { enqueueFneCertification } from "../fne/fneQueue";
import { emitFneQueued } from "../fne/fneEvents";
import { localDayEndUtc, localDayStartUtc } from "../domain/localDay";

const nextSaleNumber = (db: Database) => nextDocumentNumber(db, schema.sales, "VTE");

export interface SaleItemInput {
  variantId: number;
  quantity: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
}

export type PaymentMethod = "cash" | "card" | "mobile_money" | "credit";

export interface CreateSaleInput {
  userId: number;
  customerId?: number | null;
  newCustomerName?: string;
  saleMode: "pos" | "form";
  items: SaleItemInput[];
  discount?: number;
  redeemPoints?: number;
  paymentMethod: PaymentMethod;
  amountPaid?: number;
  surfaceLocationId: number;
  storeId: number;
  // Approbation d'un responsable : vente à crédit hors plafond, ou remise /
  // prix inférieur au catalogue non couvert par une promotion programmée.
  approval?: ApprovalInput;
  // Autorise la vente de lots périmés : exige toujours un responsable (approval).
  expiredOverride?: boolean;
  // Ordonnance : obligatoire si la vente contient un produit « sur ordonnance ».
  prescriptionRef?: string;
  prescriber?: string;
}

// Les prix saisis sont TTC (taxe déjà incluse, comme affiché en surface de
// vente) — le total d'une ligne est donc simplement quantité×prix-remise,
// sans rien ajouter. Le taux ne sert qu'à extraire la part de TVA contenue
// dans ce montant pour l'affichage (voir computeTaxAmount).
function computeItemTotal(item: SaleItemInput): number {
  return roundMoney(item.quantity * item.unitPrice - (item.discount ?? 0));
}

// Exporté sous un nom distinct de ServiceOrdersService.computeItemTotal
// (dupliquée volontairement là-bas) pour éviter le conflit de ré-export au
// niveau du package (index.ts fait `export *` sur tous les services).
export { computeItemTotal as computeSaleItemTotal };

// Extrait la TVA incluse dans un montant TTC : HT = TTC / (1 + taux/100),
// TVA = TTC - HT — ne jamais utiliser gross * taux/100, qui ajouterait la
// taxe au lieu de l'extraire.
export function computeTaxAmount(grossTtc: number, taxRate: number): number {
  if (taxRate <= 0) return 0;
  return grossTtc * (taxRate / (100 + taxRate));
}

// Part de remise NON couverte par une promotion programmée, calculée côté « serveur »
// à partir du catalogue et des promotions en cours (jamais sur la foi de l'écran).
// Partagée avec la revalidation d'une vente reçue d'un appareil relié (workerApproval).
export async function computeUnauthorizedDiscountForItems(
  db: Database,
  settings: { enablePromotions: boolean },
  items: { variantId: number; quantity: number; unitPrice: number; discount?: number }[],
  invoiceDiscount: number,
): Promise<number> {
  const variantIds = [...new Set(items.map((i) => i.variantId))];
  const catalogRows = await db
    .select({
      variantId: schema.productVariants.id,
      productId: schema.productVariants.productId,
      priceOverride: schema.productVariants.priceOverride,
      salePrice: schema.products.salePrice,
    })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(inArray(schema.productVariants.id, variantIds));
  const catalogByVariant = new Map(catalogRows.map((r) => [r.variantId, r] as const));
  const activePromos = settings.enablePromotions ? await getActivePromotionsWithProducts(db) : [];
  const productPromoPercent = (productId: number) =>
    activePromos
      .filter((p) => p.scope === "product" && p.productIds.includes(productId))
      .reduce((best, p) => Math.max(best, p.discountPercent), 0);
  const invoicePromoPercent = activePromos.filter((p) => p.scope === "invoice").reduce((best, p) => Math.max(best, p.discountPercent), 0);
  return computeUnauthorizedDiscount({
    lines: items.map((item) => {
      const row = catalogByVariant.get(item.variantId);
      return {
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        catalogPrice: row ? (row.priceOverride ?? row.salePrice) : item.unitPrice,
        promoPercent: row ? productPromoPercent(row.productId) : 0,
      };
    }),
    invoiceDiscount,
    invoicePromoPercent,
  });
}

export async function createSale(db: Database, input: CreateSaleInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_sales");
  if (input.items.length === 0) {
    throw new Error(t("coreErrors.sales.itemRequired"));
  }
  assertValidLines(input.items);
  if (input.discount !== undefined) assertValidAmount(input.discount, { allowZero: true });
  if (input.amountPaid !== undefined) assertValidAmount(input.amountPaid, { allowZero: true });
  // Responsable vérifié hors transaction (voir RefundsService.createRefund).
  const verifiedApproverId = await verifyApprovalInput(db, input.userId, input.approval);

  // Toute la séquence lecture-validation-écriture est atomique (voir
  // withTransaction) : sans ça, deux ventes concurrentes pourraient toutes
  // deux valider la même dernière unité de stock disponible avant qu'aucune
  // n'écrive, ou une erreur en cours de route laisserait une vente à moitié
  // enregistrée (ex : stock décrémenté sans paiement inséré).
  const { sale, event, fneEnabled } = await withTransaction(async () => {
    // Un lot périmé ne se vend pas : on ne compte que le stock vendable. Si la
    // vente a besoin de lots périmés, seule une dérogation approuvée par un
    // responsable (toujours exigée, même sans seuil configuré) la laisse passer.
    const today = todayISO();
    const expiredLines: Array<{ variantId: number; quantity: number; value: number }> = [];
    for (const item of input.items) {
      const info = await getSellableQuantity(db, item.variantId, input.surfaceLocationId, today);
      if (item.quantity > info.total) {
        throw new Error(t("coreErrors.sales.insufficientStock", { available: info.total }));
      }
      if (item.quantity > info.sellable) {
        if (!input.expiredOverride) {
          throw new ExpiredStockError(
            t("coreErrors.pharmacy.expiredStock", { available: info.sellable, expired: info.expiredRemaining }),
            info.sellable,
            info.expiredRemaining,
          );
        }
        const cost = await db
          .select({ cost: schema.products.purchasePrice })
          .from(schema.productVariants)
          .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
          .where(eq(schema.productVariants.id, item.variantId))
          .get();
        const expiredUsed = item.quantity - info.sellable;
        expiredLines.push({ variantId: item.variantId, quantity: expiredUsed, value: expiredUsed * (cost?.cost ?? 0) });
      }
    }
    let expiredApprovedBy: number | null = null;
    if (expiredLines.length > 0) {
      expiredApprovedBy = await checkApproval(db, {
        kind: "stock",
        amount: Math.max(0.01, expiredLines.reduce((sum, l) => sum + l.value, 0)),
        userId: input.userId,
        actingPermissions,
        verifiedApproverId,
        thresholdOverride: 0,
      });
    }
    const expiredOverrideVariants = new Set(expiredLines.map((l) => l.variantId));

    // Produit délivré sur ordonnance : la référence est obligatoire et reste
    // attachée à la vente (traçabilité en cas de contrôle ou de rappel de lot).
    const prescriptionRows = await db
      .select({ requiresPrescription: schema.products.requiresPrescription })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(inArray(schema.productVariants.id, input.items.map((i) => i.variantId)));
    if (missingPrescription(prescriptionRows, input.prescriptionRef)) {
      throw new Error(t("coreErrors.pharmacy.prescriptionRequired"));
    }
    const prescriptionRef = input.prescriptionRef?.trim() || null;
    const prescriber = input.prescriber?.trim() || null;
    const hasPrescriptionProduct = prescriptionRows.some((r) => r.requiresPrescription);

    // Résolu ici (après la validation du stock, avant tout insert) pour rester
    // idempotent : une nouvelle tentative avec le même nom réutilise le client
    // déjà créé au lieu d'en créer un doublon. Fait tôt car le rachat de points
    // a besoin du client résolu avant de calculer la réduction.
    const trimmedName = input.newCustomerName?.trim();
    let customerId = input.customerId ?? null;
    // Voir CLAUDE.md, mode réseau Phase 2 : si cette vente crée un nouveau
    // client de passage, l'événement de synchronisation doit porter sa
    // propre identité (syncId) pour que les autres appareils sachent qu'il
    // s'agit d'un client tout neuf, pas d'une référence à un client déjà
    // connu — `findOrCreateCustomerByName` peut renvoyer un client déjà
    // existant (même nom), auquel cas ce syncId candidat n'a jamais été
    // utilisé et ne doit pas apparaître dans l'événement.
    let newCustomer: { syncId: string; fullName: string } | undefined;
    if (!customerId && trimmedName) {
      const candidateSyncId = crypto.randomUUID();
      const customer = await findOrCreateCustomerByName(db, trimmedName, candidateSyncId);
      customerId = customer.id;
      if (customer.syncId === candidateSyncId) {
        newCustomer = { syncId: candidateSyncId, fullName: customer.fullName };
      }
    }
    // Le client référencé (préexistant, donc déjà connu de tout appareil via
    // l'instantané initial ou une synchronisation antérieure) — capturé
    // maintenant pour l'événement, `newCustomer` couvre le cas contraire.
    const existingCustomerSyncId =
      !newCustomer && customerId
        ? (await db.select({ syncId: schema.customers.syncId }).from(schema.customers).where(eq(schema.customers.id, customerId)).get())?.syncId ?? null
        : null;

    const settings = await getSettings(db);
    const ratio = customerId ? settings.loyaltyPointsRatio : 0;

    if (input.redeemPoints) {
      if (!customerId) {
        throw new Error(t("coreErrors.sales.loyaltyRequiresCustomer"));
      }
      const customer = await db.select().from(schema.customers).where(eq(schema.customers.id, customerId)).get();
      if (!customer || input.redeemPoints > customer.loyaltyPoints) {
        throw new Error(t("coreErrors.common.insufficientLoyaltyPoints", { points: customer?.loyaltyPoints ?? 0 }));
      }
    }

    const subtotal = roundMoney(input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
    const taxTotal = input.items.reduce((sum, item) => {
      const gross = item.quantity * item.unitPrice - (item.discount ?? 0);
      return sum + computeTaxAmount(gross, item.taxRate ?? 0);
    }, 0);
    const itemsTotal = roundMoney(input.items.reduce((sum, item) => sum + computeItemTotal(item), 0));
    const redemptionDiscount = input.redeemPoints ? pointsToDiscount(input.redeemPoints, ratio) : 0;
    const discount = roundMoney((input.discount ?? 0) + redemptionDiscount);
    if (discount > itemsTotal) {
      throw new Error(t("coreErrors.sales.discountExceedsTotal"));
    }
    const total = roundMoney(Math.max(0, itemsTotal - discount));

    // Aucune réduction ne doit venir d'ailleurs que d'une promotion programmée
    // (ou de l'échange de points de fidélité) sans l'approbation d'un
    // responsable : on compare le prix vendu au catalogue et la remise aux
    // promotions réellement en cours, côté serveur (jamais sur la foi de l'écran).
    const unauthorizedDiscount = await computeUnauthorizedDiscountForItems(db, settings, input.items, input.discount ?? 0);
    let discountApprovedBy: number | null = null;
    if (unauthorizedDiscount > 0) {
      discountApprovedBy = await checkApproval(db, {
        kind: "discount",
        amount: unauthorizedDiscount,
        userId: input.userId,
        actingPermissions,
        verifiedApproverId,
      });
    }

    const amountPaid = roundMoney(input.amountPaid ?? total);
    if (amountPaid < total && !customerId) {
      throw new Error(t("coreErrors.sales.customerIdRequiredCredit"));
    }

    // Plafond de crédit du client et seuil d'approbation : lève
    // ApprovalRequiredError si la part à crédit les dépasse sans approbation.
    if (amountPaid < total) requirePermission(actingPermissions, "sell_on_credit");
    let creditApprovedBy: number | null = null;
    if (amountPaid < total) {
      creditApprovedBy = await checkCreditApproval(db, {
        customerId: customerId!,
        creditAmount: roundMoney(total - amountPaid),
        userId: input.userId,
        actingPermissions,
        verifiedApproverId,
      });
    }

    const paymentStatus = amountPaid >= total ? "paid" : amountPaid > 0 ? "partial" : "credit";
    const number = await nextSaleNumber(db);
    const saleSyncId = crypto.randomUUID();

    const sale = await db
      .insert(schema.sales)
      .values({
        syncId: saleSyncId,
        number,
        customerId,
        userId: input.userId,
        storeId: input.storeId,
        saleMode: input.saleMode,
        subtotal,
        discount,
        taxTotal,
        total,
        paymentStatus,
        prescriptionRef,
        prescriber,
      })
      .returning()
      .get();

    const itemEvents: SaleCreatedEventPayload["items"] = [];
    // Une entrée par mouvement créé, avec son `batchId` LOCAL le temps de
    // résoudre les syncId correspondants en une seule requête groupée à la
    // fin (plutôt qu'une par mouvement) — jamais exposé tel quel dans
    // l'événement final (voir la construction de `movementEvents` ci-dessous).
    const rawMovements: Array<{ batchId: number | null; payload: Omit<SyncStockMovementPayload, "batchSyncId"> }> = [];

    for (const item of input.items) {
      const itemSyncId = crypto.randomUUID();
      await db.insert(schema.saleItems).values({
        syncId: itemSyncId,
        saleId: sale.id,
        variantId: item.variantId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount ?? 0,
        taxRate: item.taxRate ?? 0,
        total: computeItemTotal(item),
      });
      itemEvents.push({
        syncId: itemSyncId,
        variantId: item.variantId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount ?? 0,
        taxRate: item.taxRate ?? 0,
        total: computeItemTotal(item),
      });

      const movements = await consumeStockFefo(db, {
        variantId: item.variantId,
        locationId: input.surfaceLocationId,
        quantity: item.quantity,
        movementType: "sale",
        referenceType: "sale",
        referenceId: sale.id,
        userId: input.userId,
        includeExpired: expiredOverrideVariants.has(item.variantId),
      });
      for (const movement of movements) {
        rawMovements.push({
          batchId: movement.batchId,
          payload: {
            syncId: movement.syncId!,
            variantId: movement.variantId,
            locationId: movement.locationId,
            quantityDelta: movement.quantityDelta,
            movementType: movement.movementType,
            referenceType: movement.referenceType,
          },
        });
      }
    }

    const referencedBatchIds = [...new Set(rawMovements.map((m) => m.batchId).filter((id): id is number => id != null))];
    const batchSyncIdById = new Map<number, string | null>();
    if (referencedBatchIds.length > 0) {
      const batchRows = await db
        .select({ id: schema.stockBatches.id, syncId: schema.stockBatches.syncId })
        .from(schema.stockBatches)
        .where(inArray(schema.stockBatches.id, referencedBatchIds));
      for (const row of batchRows) batchSyncIdById.set(row.id, row.syncId);
    }
    const movementEvents: SyncStockMovementPayload[] = rawMovements.map((m) => ({
      ...m.payload,
      batchSyncId: m.batchId != null ? (batchSyncIdById.get(m.batchId) ?? null) : null,
    }));

    let paymentEvent: SaleCreatedEventPayload["payment"];
    if (amountPaid > 0) {
      const paymentSyncId = crypto.randomUUID();
      await db.insert(schema.payments).values({
        syncId: paymentSyncId,
        referenceType: "sale",
        referenceId: sale.id,
        method: input.paymentMethod,
        amount: amountPaid,
        receivedBy: input.userId,
        storeId: input.storeId,
      });
      paymentEvent = { syncId: paymentSyncId, method: input.paymentMethod, amount: amountPaid, storeId: input.storeId };
    }

    let creditEvent: SaleCreatedEventPayload["credit"];
    if (amountPaid < total) {
      const creditSyncId = crypto.randomUUID();
      await db.insert(schema.customerCredits).values({
        syncId: creditSyncId,
        customerId: customerId!,
        saleId: sale.id,
        storeId: input.storeId,
        originalAmount: roundMoney(total - amountPaid),
        remainingBalance: roundMoney(total - amountPaid),
        status: "open",
        approvedBy: creditApprovedBy ?? undefined,
      });
      creditEvent = { syncId: creditSyncId, originalAmount: roundMoney(total - amountPaid), remainingBalance: roundMoney(total - amountPaid), storeId: input.storeId };
    }

    let loyaltyRedeemEvent: SaleCreatedEventPayload["loyaltyRedeem"];
    if (input.redeemPoints && customerId) {
      const redeemSyncId = crypto.randomUUID();
      await redeemPoints(db, { customerId, points: input.redeemPoints, saleId: sale.id, ratio, syncId: redeemSyncId });
      loyaltyRedeemEvent = { syncId: redeemSyncId, pointsDelta: -input.redeemPoints };
    }
    let loyaltyEarnEvent: SaleCreatedEventPayload["loyaltyEarn"];
    if (customerId) {
      const earnSyncId = crypto.randomUUID();
      const earned = await earnPoints(db, { customerId, amount: total, saleId: sale.id, ratio, syncId: earnSyncId });
      if (earned) loyaltyEarnEvent = { syncId: earnSyncId, pointsDelta: earned.pointsDelta };
    }

    await logAction(db, {
      userId: input.userId,
      action: "create_sale",
      entity: "sale",
      entityId: sale.id,
      metadata: {
        number: sale.number,
        total,
        paymentStatus,
        // Remise hors promotion : montant et responsable qui l'a approuvée (pour le tableau de bord Contrôles).
        ...(unauthorizedDiscount > 0 ? { unauthorizedDiscount, discountApprovedBy } : {}),
        // Vente sur ordonnance : référence et prescripteur (traçabilité, Contrôles).
        ...(hasPrescriptionProduct ? { prescription: { ref: prescriptionRef, prescriber } } : {}),
        // Vente de lots périmés autorisée par un responsable (dérogation).
        ...(expiredLines.length > 0 ? { expiredOverride: { approvedBy: expiredApprovedBy, lines: expiredLines } } : {}),
      },
    });

    const payload: SaleCreatedEventPayload = {
      sale: {
        syncId: saleSyncId,
        number: sale.number,
        customerSyncId: newCustomer?.syncId ?? existingCustomerSyncId,
        userId: sale.userId,
        storeId: sale.storeId,
        saleMode: sale.saleMode,
        subtotal: sale.subtotal,
        discount: sale.discount,
        taxTotal: sale.taxTotal,
        total: sale.total,
        paymentStatus: sale.paymentStatus,
        createdAt: sale.createdAt,
        prescriptionRef: sale.prescriptionRef,
        prescriber: sale.prescriber,
      },
      newCustomer,
      items: itemEvents,
      stockMovements: movementEvents,
      payment: paymentEvent,
      credit: creditEvent,
      loyaltyRedeem: loyaltyRedeemEvent,
      loyaltyEarn: loyaltyEarnEvent,
    };

    return { sale, event: buildSyncEvent("sale.created", payload, { actorId: input.userId, approverId: verifiedApproverId }), fneEnabled: settings.fneEnabled };
  });

  emitSyncEvent(event);
  // Voir CLAUDE.md, FNE — mise en file d'attente, jamais bloquant pour la
  // vente elle-même (déjà commitée et retournée à ce stade). La tentative de
  // certification réelle est faite ailleurs (apps/web/src/features/fne).
  if (fneEnabled) {
    await enqueueFneCertification(db, sale.id);
    emitFneQueued();
  }
  return sale;
}

export interface SaleFilters {
  from?: string; // "YYYY-MM-DD"
  to?: string;
  userId?: number;
  paymentStatus?: string;
  search?: string; // LIKE sur number
  storeId?: number;
  customerId?: number;
  paymentMethod?: string;
  // Pagination (les plus récentes d'abord) : sans `limit`, tout est renvoyé.
  limit?: number;
  offset?: number;
}

export async function listSales(db: Database, filters: SaleFilters = {}) {
  const conditions = [];
  if (filters.from) conditions.push(gte(schema.sales.createdAt, localDayStartUtc(filters.from)));
  if (filters.to) conditions.push(lte(schema.sales.createdAt, localDayEndUtc(filters.to)));
  if (filters.userId) conditions.push(eq(schema.sales.userId, filters.userId));
  if (filters.paymentStatus) conditions.push(eq(schema.sales.paymentStatus, filters.paymentStatus));
  if (filters.search) conditions.push(like(schema.sales.number, `%${filters.search}%`));
  if (filters.storeId) conditions.push(eq(schema.sales.storeId, filters.storeId));
  if (filters.customerId) conditions.push(eq(schema.sales.customerId, filters.customerId));

  // Le mode de paiement vit sur `payments` (referenceType='sale'), pas sur
  // `sales` : sous-requête plutôt que d'envoyer des milliers d'identifiants
  // (SQLite limite le nombre de paramètres d'une requête).
  if (filters.paymentMethod) {
    conditions.push(
      inArray(
        schema.sales.id,
        db
          .select({ referenceId: schema.payments.referenceId })
          .from(schema.payments)
          .where(and(eq(schema.payments.referenceType, "sale"), eq(schema.payments.method, filters.paymentMethod))),
      ),
    );
  }

  let query = db.select().from(schema.sales).orderBy(desc(schema.sales.id)).$dynamic();
  if (conditions.length > 0) query = query.where(and(...conditions));
  if (filters.limit != null) query = query.limit(filters.limit).offset(filters.offset ?? 0);
  return query;
}

export async function listSaleItems(db: Database, saleId: number) {
  return db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, saleId));
}

// Une seule ligne de paiement par vente à la création (voir createSale) — un
// rachat de créance ultérieur crée sa propre ligne avec referenceType
// 'credit_repayment', jamais 'sale', donc `.get()` reste correct même après.
export async function getSalePayment(db: Database, saleId: number) {
  return db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.referenceType, "sale"), eq(schema.payments.referenceId, saleId)))
    .get();
}

// Charge tous les paiements de vente en une fois (utilisé par les vues qui
// affichent une liste de ventes et ont besoin du mode de paiement de chacune
// sans faire une requête par ligne).
// `saleIds` restreint aux ventes affichées (une page) au lieu de tout l'historique.
export async function listSalePayments(db: Database, saleIds?: number[]) {
  if (!saleIds) return db.select().from(schema.payments).where(eq(schema.payments.referenceType, "sale"));
  const rows: (typeof schema.payments.$inferSelect)[] = [];
  for (let i = 0; i < saleIds.length; i += 500) {
    rows.push(
      ...(await db
        .select()
        .from(schema.payments)
        .where(and(eq(schema.payments.referenceType, "sale"), inArray(schema.payments.referenceId, saleIds.slice(i, i + 500))))),
    );
  }
  return rows;
}
