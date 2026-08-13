import type { Database } from "@gestion-boutique/database";
import { schema, withTransaction } from "@gestion-boutique/database";
import { desc, eq, sql } from "drizzle-orm";
import { logAction } from "./AuditService";
import { requirePermission, type PermissionSet } from "../domain/permissions";
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

export interface CreatePurchaseInput {
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
    throw new Error("L'achat doit contenir au moins un article.");
  }
  for (const item of input.items) {
    if (item.quantity <= 0) {
      throw new Error("La quantité de chaque article doit être supérieure à zéro.");
    }
  }

  // Même raisonnement que SalesService.createSale/RefundsService.createRefund :
  // toute la séquence lecture-validation-écriture doit être atomique, pas
  // seulement les écritures — un achat enregistré sans que le stock ne bouge
  // (ou l'inverse) laisserait la comptabilité et le stock désynchronisés.
  return withTransaction(async () => {
    const locations = await listLocations(db, input.storeId);
    const reserve = locations.find((l) => l.type === "reserve" || l.type.startsWith("reserve#"));
    if (!reserve) {
      throw new Error("Emplacement de réserve introuvable pour cette boutique.");
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
        storeId: input.storeId,
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
  });
}

export async function listPurchases(db: Database, storeId?: number) {
  const query = db.select().from(schema.purchases).orderBy(desc(schema.purchases.id));
  return storeId ? query.where(eq(schema.purchases.storeId, storeId)) : query;
}

export async function listPurchaseItems(db: Database, purchaseId: number) {
  return db.select().from(schema.purchaseItems).where(eq(schema.purchaseItems.purchaseId, purchaseId));
}
