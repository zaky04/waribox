import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { desc, eq, sql } from "drizzle-orm";
import { logAction } from "./AuditService";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { createSale, type PaymentMethod } from "./SalesService";
import { findOrCreateCustomerByName } from "./CustomersService";

async function nextQuoteNumber(db: Database): Promise<string> {
  const row = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.quotes).get();
  const year = new Date().getFullYear();
  const seq = ((row?.count as unknown as number) ?? 0) + 1;
  return `DEV-${year}-${String(seq).padStart(6, "0")}`;
}

export interface QuoteItemInput {
  variantId: number;
  quantity: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
}

// Prix TTC, comme SalesService.computeItemTotal — voir ce fichier pour le
// détail du modèle (le taux extrait la TVA, il ne l'ajoute pas).
function computeItemTotal(item: QuoteItemInput): number {
  return item.quantity * item.unitPrice - (item.discount ?? 0);
}

export interface CreateQuoteInput {
  customerId?: number | null;
  newCustomerName?: string;
  items: QuoteItemInput[];
  validUntil?: string;
  createdBy?: number;
  storeId?: number;
}

export async function createQuote(db: Database, input: CreateQuoteInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_quotes");
  if (input.items.length === 0) {
    throw new Error(t("coreErrors.quotes.itemRequired"));
  }

  const trimmedName = input.newCustomerName?.trim();
  let customerId = input.customerId ?? null;
  if (!customerId && trimmedName) {
    const customer = await findOrCreateCustomerByName(db, trimmedName);
    customerId = customer.id;
  }

  const total = input.items.reduce((sum, item) => sum + computeItemTotal(item), 0);
  const number = await nextQuoteNumber(db);

  const quote = await db
    .insert(schema.quotes)
    .values({ number, customerId, total, validUntil: input.validUntil ?? null, storeId: input.storeId })
    .returning()
    .get();

  for (const item of input.items) {
    await db.insert(schema.quoteItems).values({
      quoteId: quote.id,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discount: item.discount ?? 0,
      taxRate: item.taxRate ?? 0,
      total: computeItemTotal(item),
    });
  }

  if (input.createdBy) {
    await logAction(db, {
      userId: input.createdBy,
      action: "create_quote",
      entity: "quote",
      entityId: quote.id,
      metadata: { number: quote.number, total },
    });
  }

  return quote;
}

export async function listQuotes(db: Database, storeId?: number) {
  const query = db.select().from(schema.quotes).orderBy(desc(schema.quotes.id));
  return storeId ? query.where(eq(schema.quotes.storeId, storeId)) : query;
}

export async function listQuoteItems(db: Database, quoteId: number) {
  return db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quoteId));
}

export async function updateQuoteStatus(
  db: Database,
  quoteId: number,
  status: "pending" | "accepted" | "expired",
  userId: number,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "edit_quotes");
  const updated = await db
    .update(schema.quotes)
    .set({ status })
    .where(eq(schema.quotes.id, quoteId))
    .returning()
    .get();

  await logAction(db, {
    userId,
    action: "update_quote_status",
    entity: "quote",
    entityId: quoteId,
    metadata: { status },
  });

  return updated;
}

export interface ConvertQuoteToSaleInput {
  surfaceLocationId: number;
  paymentMethod: PaymentMethod;
  amountPaid?: number;
  userId: number;
  storeId: number;
}

export async function convertQuoteToSale(
  db: Database,
  quoteId: number,
  input: ConvertQuoteToSaleInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_quotes");
  const quote = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId)).get();
  if (!quote) {
    throw new Error(t("coreErrors.quotes.notFound"));
  }
  if (quote.status === "converted") {
    throw new Error(t("coreErrors.quotes.alreadyConverted"));
  }

  const items = await listQuoteItems(db, quoteId);
  if (items.length === 0) {
    throw new Error(t("coreErrors.quotes.noItems"));
  }

  const sale = await createSale(
    db,
    {
      userId: input.userId,
      customerId: quote.customerId,
      saleMode: "form",
      items: items.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        taxRate: item.taxRate,
      })),
      paymentMethod: input.paymentMethod,
      amountPaid: input.amountPaid,
      surfaceLocationId: input.surfaceLocationId,
      storeId: input.storeId,
    },
    actingPermissions,
  );

  await db
    .update(schema.quotes)
    .set({ status: "converted", convertedSaleId: sale.id })
    .where(eq(schema.quotes.id, quoteId))
    .run();

  return sale;
}
