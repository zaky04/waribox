import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { desc, eq, sql } from "drizzle-orm";
import { logAction } from "./AuditService";
import { listLocations, recordMovement } from "./StockService";

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

export interface CreatePurchaseInput {
  userId: number;
  supplierId: number;
  items: PurchaseItemInput[];
  paymentMethod: PurchasePaymentMethod;
  amountPaid?: number;
  dueDate?: string;
}

export async function createPurchase(db: Database, input: CreatePurchaseInput) {
  if (input.items.length === 0) {
    throw new Error("L'achat doit contenir au moins un article.");
  }
  for (const item of input.items) {
    if (item.quantity <= 0) {
      throw new Error("La quantité de chaque article doit être supérieure à zéro.");
    }
  }

  const locations = await listLocations(db);
  const reserve = locations.find((l) => l.type === "reserve");
  if (!reserve) {
    throw new Error("Emplacement de réserve introuvable.");
  }

  const total = input.items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
  const amountPaid = input.amountPaid ?? total;

  const number = await nextPurchaseNumber(db);

  const purchase = await db
    .insert(schema.purchases)
    .values({
      number,
      supplierId: input.supplierId,
      userId: input.userId,
      total,
    })
    .returning()
    .get();

  for (const item of input.items) {
    await db.insert(schema.purchaseItems).values({
      purchaseId: purchase.id,
      variantId: item.variantId,
      quantity: item.quantity,
      unitCost: item.unitCost,
    });

    await recordMovement(db, {
      variantId: item.variantId,
      locationId: reserve.id,
      quantityDelta: item.quantity,
      movementType: "purchase",
      referenceType: "purchase",
      referenceId: purchase.id,
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
    });
  }

  if (amountPaid < total) {
    await db.insert(schema.supplierDebts).values({
      supplierId: input.supplierId,
      purchaseId: purchase.id,
      originalAmount: total - amountPaid,
      remainingBalance: total - amountPaid,
      dueDate: input.dueDate,
      status: "open",
    });
  }

  await logAction(db, {
    userId: input.userId,
    action: "create_purchase",
    entity: "purchase",
    entityId: purchase.id,
    metadata: { number: purchase.number, total },
  });

  return purchase;
}

export async function listPurchases(db: Database) {
  return db.select().from(schema.purchases).orderBy(desc(schema.purchases.id));
}

export async function listPurchaseItems(db: Database, purchaseId: number) {
  return db.select().from(schema.purchaseItems).where(eq(schema.purchaseItems.purchaseId, purchaseId));
}
