import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { and, desc, eq, gte, inArray, like, lte, sql } from "drizzle-orm";
import { withTransaction } from "@gestion-boutique/database";
import { logAction } from "./AuditService";
import { findOrCreateCustomerByName } from "./CustomersService";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { earnPoints, pointsToDiscount, redeemPoints } from "./LoyaltyService";
import { getSettings } from "./SettingsService";
import { consumeStockFefo, getStockLevels } from "./StockService";

async function nextSaleNumber(db: Database): Promise<string> {
  const row = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.sales).get();
  const year = new Date().getFullYear();
  const seq = ((row?.count as unknown as number) ?? 0) + 1;
  return `VTE-${year}-${String(seq).padStart(6, "0")}`;
}

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
}

// Les prix saisis sont TTC (taxe déjà incluse, comme affiché en surface de
// vente) — le total d'une ligne est donc simplement quantité×prix-remise,
// sans rien ajouter. Le taux ne sert qu'à extraire la part de TVA contenue
// dans ce montant pour l'affichage (voir computeTaxAmount).
function computeItemTotal(item: SaleItemInput): number {
  return item.quantity * item.unitPrice - (item.discount ?? 0);
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

export async function createSale(db: Database, input: CreateSaleInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_sales");
  if (input.items.length === 0) {
    throw new Error(t("coreErrors.sales.itemRequired"));
  }

  // Toute la séquence lecture-validation-écriture est atomique (voir
  // withTransaction) : sans ça, deux ventes concurrentes pourraient toutes
  // deux valider la même dernière unité de stock disponible avant qu'aucune
  // n'écrive, ou une erreur en cours de route laisserait une vente à moitié
  // enregistrée (ex : stock décrémenté sans paiement inséré).
  return withTransaction(async () => {
    const levels = await getStockLevels(db);
    for (const item of input.items) {
      const available = levels
        .filter((l) => l.variantId === item.variantId && l.locationId === input.surfaceLocationId)
        .reduce((sum, l) => sum + l.quantity, 0);
      if (item.quantity > available) {
        throw new Error(t("coreErrors.sales.insufficientStock", { available }));
      }
    }

    // Résolu ici (après la validation du stock, avant tout insert) pour rester
    // idempotent : une nouvelle tentative avec le même nom réutilise le client
    // déjà créé au lieu d'en créer un doublon. Fait tôt car le rachat de points
    // a besoin du client résolu avant de calculer la réduction.
    const trimmedName = input.newCustomerName?.trim();
    let customerId = input.customerId ?? null;
    if (!customerId && trimmedName) {
      const customer = await findOrCreateCustomerByName(db, trimmedName);
      customerId = customer.id;
    }

    const ratio = customerId ? (await getSettings(db)).loyaltyPointsRatio : 0;

    if (input.redeemPoints) {
      if (!customerId) {
        throw new Error(t("coreErrors.sales.loyaltyRequiresCustomer"));
      }
      const customer = await db.select().from(schema.customers).where(eq(schema.customers.id, customerId)).get();
      if (!customer || input.redeemPoints > customer.loyaltyPoints) {
        throw new Error(t("coreErrors.common.insufficientLoyaltyPoints", { points: customer?.loyaltyPoints ?? 0 }));
      }
    }

    const subtotal = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    const taxTotal = input.items.reduce((sum, item) => {
      const gross = item.quantity * item.unitPrice - (item.discount ?? 0);
      return sum + computeTaxAmount(gross, item.taxRate ?? 0);
    }, 0);
    const itemsTotal = input.items.reduce((sum, item) => sum + computeItemTotal(item), 0);
    const redemptionDiscount = input.redeemPoints ? pointsToDiscount(input.redeemPoints, ratio) : 0;
    const discount = (input.discount ?? 0) + redemptionDiscount;
    if (discount > itemsTotal) {
      throw new Error(t("coreErrors.sales.discountExceedsTotal"));
    }
    const total = Math.max(0, itemsTotal - discount);

    const amountPaid = input.amountPaid ?? total;
    if (amountPaid < total && !customerId) {
      throw new Error(t("coreErrors.sales.customerIdRequiredCredit"));
    }

    const paymentStatus = amountPaid >= total ? "paid" : amountPaid > 0 ? "partial" : "credit";
    const number = await nextSaleNumber(db);

    const sale = await db
      .insert(schema.sales)
      .values({
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
      })
      .returning()
      .get();

    for (const item of input.items) {
      await db.insert(schema.saleItems).values({
        saleId: sale.id,
        variantId: item.variantId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount ?? 0,
        taxRate: item.taxRate ?? 0,
        total: computeItemTotal(item),
      });

      await consumeStockFefo(db, {
        variantId: item.variantId,
        locationId: input.surfaceLocationId,
        quantity: item.quantity,
        movementType: "sale",
        referenceType: "sale",
        referenceId: sale.id,
        userId: input.userId,
      });
    }

    if (amountPaid > 0) {
      await db.insert(schema.payments).values({
        referenceType: "sale",
        referenceId: sale.id,
        method: input.paymentMethod,
        amount: amountPaid,
        receivedBy: input.userId,
        storeId: input.storeId,
      });
    }

    if (amountPaid < total) {
      await db.insert(schema.customerCredits).values({
        customerId: customerId!,
        saleId: sale.id,
        storeId: input.storeId,
        originalAmount: total - amountPaid,
        remainingBalance: total - amountPaid,
        status: "open",
      });
    }

    if (input.redeemPoints && customerId) {
      await redeemPoints(db, { customerId, points: input.redeemPoints, saleId: sale.id, ratio });
    }
    if (customerId) {
      await earnPoints(db, { customerId, amount: total, saleId: sale.id, ratio });
    }

    await logAction(db, {
      userId: input.userId,
      action: "create_sale",
      entity: "sale",
      entityId: sale.id,
      metadata: { number: sale.number, total, paymentStatus },
    });

    return sale;
  });
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
}

export async function listSales(db: Database, filters: SaleFilters = {}) {
  const conditions = [];
  if (filters.from) conditions.push(gte(schema.sales.createdAt, `${filters.from.slice(0, 10)} 00:00:00`));
  if (filters.to) conditions.push(lte(schema.sales.createdAt, `${filters.to.slice(0, 10)} 23:59:59`));
  if (filters.userId) conditions.push(eq(schema.sales.userId, filters.userId));
  if (filters.paymentStatus) conditions.push(eq(schema.sales.paymentStatus, filters.paymentStatus));
  if (filters.search) conditions.push(like(schema.sales.number, `%${filters.search}%`));
  if (filters.storeId) conditions.push(eq(schema.sales.storeId, filters.storeId));
  if (filters.customerId) conditions.push(eq(schema.sales.customerId, filters.customerId));

  // Le mode de paiement vit sur `payments` (referenceType='sale'), pas sur
  // `sales` — résolu ici en deux requêtes plutôt qu'une jointure pour rester
  // dans le style du reste du fichier (pas de leftJoin ailleurs dans ce
  // service). Un tableau vide ici veut dire "aucune vente ne correspond".
  if (filters.paymentMethod) {
    const paymentRows = await db
      .select({ referenceId: schema.payments.referenceId })
      .from(schema.payments)
      .where(and(eq(schema.payments.referenceType, "sale"), eq(schema.payments.method, filters.paymentMethod)));
    if (paymentRows.length === 0) return [];
    conditions.push(
      inArray(
        schema.sales.id,
        paymentRows.map((p) => p.referenceId),
      ),
    );
  }

  const query = db.select().from(schema.sales).orderBy(desc(schema.sales.id));
  return conditions.length > 0 ? query.where(and(...conditions)) : query;
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
export async function listSalePayments(db: Database) {
  return db.select().from(schema.payments).where(eq(schema.payments.referenceType, "sale"));
}
