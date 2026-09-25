import { roundMoney } from "../domain/money";
import type { Database } from "@gestion-boutique/database";
import { schema, withTransaction } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { and, desc, eq, sql } from "drizzle-orm";
import { logAction } from "./AuditService";
import { requireAnyPermission, requirePermission, type PermissionSet } from "../domain/permissions";
import { getSettings } from "./SettingsService";
import { createBatch, listLocations, recordMovement } from "./StockService";

async function nextPurchaseNumber(db: Database): Promise<string> {
  const row = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.purchases).get();
  const year = new Date().getFullYear();
  const seq = ((row?.count as unknown as number) ?? 0) + 1;
  return `ACH-${year}-${String(seq).padStart(6, "0")}`;
}

export interface PurchaseItemInput {
  variantId: number;
  quantity: number;
  unitCost: number;
}

export type PurchasePaymentMethod = "cash" | "card" | "mobile_money" | "credit";

// Dernier coût unitaire connu de chaque variante (dernier achat, à défaut le prix
// d'achat du catalogue) — référence de la détection de hausse de prix.
export async function getPriceReferences(db: Database, variantIds: number[]): Promise<Map<number, number>> {
  const refs = new Map<number, number>();
  for (const variantId of variantIds) {
    const last = await db
      .select({ unitCost: schema.purchaseItems.unitCost })
      .from(schema.purchaseItems)
      .where(eq(schema.purchaseItems.variantId, variantId))
      .orderBy(desc(schema.purchaseItems.id))
      .limit(1)
      .get();
    if (last && last.unitCost > 0) {
      refs.set(variantId, last.unitCost);
      continue;
    }
    const catalog = await db
      .select({ cost: schema.products.purchasePrice })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(eq(schema.productVariants.id, variantId))
      .get();
    if (catalog && catalog.cost > 0) refs.set(variantId, catalog.cost);
  }
  return refs;
}

// Hausse en % par rapport à la référence (0 si pas de référence ou baisse).
export function priceIncreasePercent(previousCost: number | undefined, unitCost: number): number {
  if (!previousCost || previousCost <= 0 || unitCost <= previousCost) return 0;
  return ((unitCost - previousCost) / previousCost) * 100;
}

export interface CreatePurchaseInput {
  // Numéro de la facture/du bon du fournisseur : sert au rapprochement et à
  // refuser une facture saisie deux fois.
  invoiceReference?: string;
  userId: number;
  supplierId: number;
  items: PurchaseItemInput[];
  paymentMethod: PurchasePaymentMethod;
  amountPaid?: number;
  dueDate?: string;
  storeId: number;
}

export async function createPurchase(
  db: Database,
  input: CreatePurchaseInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_suppliers");
  if (input.items.length === 0) {
    throw new Error(t("coreErrors.purchases.itemRequired"));
  }
  for (const item of input.items) {
    if (item.quantity <= 0) {
      throw new Error(t("coreErrors.purchases.quantityPositive"));
    }
  }

  const invoiceReference = input.invoiceReference?.trim() || undefined;
  if (invoiceReference) {
    const duplicate = await db
      .select({ id: schema.purchases.id })
      .from(schema.purchases)
      .where(and(eq(schema.purchases.supplierId, input.supplierId), eq(schema.purchases.invoiceReference, invoiceReference)))
      .get();
    if (duplicate) throw new Error(t("coreErrors.purchases.duplicateInvoice", { reference: invoiceReference }));
  }
  const settings = await getSettings(db);
  // Achats en deux temps : la facture est saisie ici, le stock n'entre qu'à la
  // réception contrôlée (receivePurchase).
  const twoStep = settings.requirePurchaseReceipt;
  const priceRefs = await getPriceReferences(db, input.items.map((i) => i.variantId));

  // Même raisonnement que SalesService.createSale/RefundsService.createRefund :
  // toute la séquence lecture-validation-écriture doit être atomique, pas
  // seulement les écritures — un achat enregistré sans que le stock ne bouge
  // (ou l'inverse) laisserait la comptabilité et le stock désynchronisés.
  return withTransaction(async () => {
    const locations = await listLocations(db, input.storeId);
    const reserve = locations.find((l) => l.type === "reserve" || l.type.startsWith("reserve#"));
    if (!reserve) {
      throw new Error(t("coreErrors.purchases.reserveLocationNotFound"));
    }

    const total = roundMoney(input.items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0));
    const amountPaid = roundMoney(input.amountPaid ?? total);

    const number = await nextPurchaseNumber(db);

    const purchase = await db
      .insert(schema.purchases)
      .values({
        number,
        supplierId: input.supplierId,
        userId: input.userId,
        storeId: input.storeId,
        total,
        status: twoStep ? "ordered" : "received",
        invoiceReference,
        receivedAt: twoStep ? undefined : new Date().toISOString().replace("T", " ").slice(0, 19),
        receivedBy: twoStep ? undefined : input.userId,
      })
      .returning()
      .get();

    const priceAlerts: { variantId: number; previousUnitCost: number; unitCost: number; increasePercent: number }[] = [];
    for (const item of input.items) {
      const previousUnitCost = priceRefs.get(item.variantId);
      const increasePercent = priceIncreasePercent(previousUnitCost, item.unitCost);
      const priceAlert = settings.priceAlertPercent > 0 && increasePercent > settings.priceAlertPercent;
      if (priceAlert) {
        priceAlerts.push({ variantId: item.variantId, previousUnitCost: previousUnitCost!, unitCost: item.unitCost, increasePercent: Math.round(increasePercent * 10) / 10 });
      }
      await db.insert(schema.purchaseItems).values({
        purchaseId: purchase.id,
        variantId: item.variantId,
        quantity: item.quantity,
        unitCost: item.unitCost,
        receivedQuantity: twoStep ? undefined : item.quantity,
        previousUnitCost,
        priceAlert,
      });

      if (twoStep) continue;

      // Chaque ligne d'achat devient son propre lot, coût inclus — sans ça,
      // le stock acheté partait sans traçabilité de coût (voir le commentaire
      // sur ReportsService.getMarginsSummary) et sans participer au FEFO. Un
      // lot sans date de péremption se range naturellement après les lots
      // périssables dans consumeStockFefo (voir son tri), donc ça ne change
      // rien à la priorité des produits suivis en péremption.
      const batch = await createBatch(db, {
        variantId: item.variantId,
        locationId: reserve.id,
        quantity: item.quantity,
        expiryDate: undefined,
        unitCost: item.unitCost,
      });

      await recordMovement(db, {
        variantId: item.variantId,
        locationId: reserve.id,
        quantityDelta: item.quantity,
        movementType: "purchase",
        referenceType: "purchase",
        referenceId: purchase.id,
        batchId: batch.id,
        userId: input.userId,
      });
    }

    if (amountPaid > 0) {
      await db.insert(schema.payments).values({
        referenceType: "purchase",
        referenceId: purchase.id,
        method: input.paymentMethod,
        amount: amountPaid,
        receivedBy: input.userId,
        storeId: input.storeId,
      });
    }

    if (amountPaid < total) {
      await db.insert(schema.supplierDebts).values({
        supplierId: input.supplierId,
        purchaseId: purchase.id,
        storeId: input.storeId,
        originalAmount: roundMoney(total - amountPaid),
        remainingBalance: roundMoney(total - amountPaid),
        dueDate: input.dueDate,
        status: "open",
      });
    }

    await logAction(db, {
      userId: input.userId,
      action: "create_purchase",
      entity: "purchase",
      entityId: purchase.id,
      metadata: { number: purchase.number, total, invoiceReference, awaitingReceipt: twoStep, priceAlerts },
    });

    return purchase;
  });
}

export interface ReceivePurchaseInput {
  purchaseId: number;
  userId: number;
  // Quantité réellement comptée pour chaque ligne de la facture.
  lines: { purchaseItemId: number; receivedQuantity: number }[];
  note?: string;
}

// Réception contrôlée d'un achat saisi en deux temps : le stock n'entre que pour
// les quantités RÉELLEMENT comptées. L'écart avec la facture (manquant à
// réclamer au fournisseur) est valorisé et tracé, pas absorbé.
export async function receivePurchase(db: Database, input: ReceivePurchaseInput, actingPermissions: PermissionSet) {
  requireAnyPermission(actingPermissions, ["manage_stock", "manage_suppliers"]);
  const purchase = await db.select().from(schema.purchases).where(eq(schema.purchases.id, input.purchaseId)).get();
  if (!purchase) throw new Error(t("coreErrors.purchases.notFound"));
  if (purchase.status !== "ordered") throw new Error(t("coreErrors.purchases.notAwaitingReceipt"));

  const items = await listPurchaseItems(db, purchase.id);
  const receivedById = new Map(input.lines.map((l) => [l.purchaseItemId, l.receivedQuantity] as const));
  for (const item of items) {
    const rq = receivedById.get(item.id);
    if (rq == null || rq < 0) throw new Error(t("coreErrors.purchases.receiptQuantityRequired"));
  }

  const result = await withTransaction(async () => {
    const locations = await listLocations(db, purchase.storeId ?? undefined);
    const reserve = locations.find((l) => l.type === "reserve" || l.type.startsWith("reserve#"));
    if (!reserve) throw new Error(t("coreErrors.purchases.reserveLocationNotFound"));

    let shortfallValue = 0;
    let surplusValue = 0;
    const discrepancies: { variantId: number; invoiced: number; received: number }[] = [];
    for (const item of items) {
      const received = receivedById.get(item.id)!;
      if (received !== item.quantity) {
        discrepancies.push({ variantId: item.variantId, invoiced: item.quantity, received });
        if (received < item.quantity) shortfallValue += (item.quantity - received) * item.unitCost;
        else surplusValue += (received - item.quantity) * item.unitCost;
      }
      await db.update(schema.purchaseItems).set({ receivedQuantity: received }).where(eq(schema.purchaseItems.id, item.id)).run();
      if (received <= 0) continue;

      const batch = await createBatch(db, {
        variantId: item.variantId,
        locationId: reserve.id,
        quantity: received,
        expiryDate: undefined,
        unitCost: item.unitCost,
      });
      await recordMovement(db, {
        variantId: item.variantId,
        locationId: reserve.id,
        quantityDelta: received,
        movementType: "purchase",
        referenceType: "purchase",
        referenceId: purchase.id,
        batchId: batch.id,
        userId: input.userId,
        note: input.note?.trim() || undefined,
      });
    }

    const updated = await db
      .update(schema.purchases)
      .set({
        status: "received",
        receivedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
        receivedBy: input.userId,
      })
      .where(eq(schema.purchases.id, purchase.id))
      .returning()
      .get();
    return { purchase: updated, shortfallValue: roundMoney(shortfallValue), surplusValue: roundMoney(surplusValue), discrepancies };
  });

  await logAction(db, {
    userId: input.userId,
    action: "receive_purchase",
    entity: "purchase",
    entityId: purchase.id,
    metadata: {
      number: purchase.number,
      shortfallValue: result.shortfallValue,
      surplusValue: result.surplusValue,
      discrepancies: result.discrepancies,
      // Même personne à la saisie de la facture et à la réception : à surveiller.
      sameUser: purchase.userId === input.userId,
      note: input.note?.trim() || null,
    },
  });
  return result;
}

export async function listPurchases(db: Database, storeId?: number) {
  const query = db.select().from(schema.purchases).orderBy(desc(schema.purchases.id));
  return storeId ? query.where(eq(schema.purchases.storeId, storeId)) : query;
}

export async function listPurchaseItems(db: Database, purchaseId: number) {
  return db.select().from(schema.purchaseItems).where(eq(schema.purchaseItems.purchaseId, purchaseId));
}
