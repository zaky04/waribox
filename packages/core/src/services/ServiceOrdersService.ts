import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { logAction } from "./AuditService";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { findOrCreateCustomerByNameAndPhone } from "./CustomersService";
import { earnPoints } from "./LoyaltyService";
import { getSettings } from "./SettingsService";

// Même algorithme que SalesService.nextSaleNumber/PurchasesService.nextPurchaseNumber
// (COUNT(*)+1, pas MAX(id)) — compteur simple, cohérent avec le reste de l'app.
async function nextServiceOrderNumber(db: Database): Promise<string> {
  const row = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.serviceOrders).get();
  const year = new Date().getFullYear();
  const seq = ((row?.count as unknown as number) ?? 0) + 1;
  return `TCK-${year}-${String(seq).padStart(6, "0")}`;
}

export interface ServiceOrderItemInput {
  // Saisie manuelle, jamais liée au catalogue Produits — un pressing n'a pas
  // de catalogue produits.
  description: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
}

export type ServiceOrderPaymentMethod = "cash" | "card" | "mobile_money" | "credit";

export interface CreateServiceOrderInput {
  userId: number;
  customerId?: number | null;
  newCustomerName?: string;
  newCustomerPhone?: string;
  items: ServiceOrderItemInput[];
  promisedDate?: string;
  notes?: string;
  paymentMethod: ServiceOrderPaymentMethod;
  amountPaid?: number;
  storeId?: number;
}

// Même modèle que SalesService.computeItemTotal — dupliquée volontairement :
// module distinct (pas de stock à décrémenter), pas de couplage avec le code
// de vente déjà testé. Voir le plan pour la justification. Prix TTC : le
// taux extrait la TVA contenue dans le prix, il ne s'ajoute pas dessus.
export function computeItemTotal(item: ServiceOrderItemInput): number {
  return item.quantity * item.unitPrice - (item.discount ?? 0);
}

function computeTaxAmount(grossTtc: number, taxRate: number): number {
  if (taxRate <= 0) return 0;
  return grossTtc * (taxRate / (100 + taxRate));
}

export async function createServiceOrder(
  db: Database,
  input: CreateServiceOrderInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_service_orders");
  if (input.items.length === 0) {
    throw new Error(t("coreErrors.serviceOrders.itemRequired"));
  }

  const trimmedName = input.newCustomerName?.trim();
  let customerId = input.customerId ?? null;
  if (!customerId && trimmedName) {
    const customer = await findOrCreateCustomerByNameAndPhone(
      db,
      trimmedName,
      input.newCustomerPhone,
    );
    customerId = customer.id;
  }

  const subtotal = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const taxTotal = input.items.reduce((sum, item) => {
    const gross = item.quantity * item.unitPrice - (item.discount ?? 0);
    return sum + computeTaxAmount(gross, item.taxRate ?? 0);
  }, 0);
  const itemsTotal = input.items.reduce((sum, item) => sum + computeItemTotal(item), 0);
  // Pas de remise ni de rachat de points au niveau de l'ordre dans ce premier
  // jet (voir le plan) — seules les remises par article (déjà incluses dans
  // itemsTotal) existent pour l'instant.
  const discount = 0;
  const total = Math.max(0, itemsTotal - discount);

  const amountPaid = input.amountPaid ?? total;
  if (amountPaid < total && !customerId) {
    throw new Error(t("coreErrors.serviceOrders.customerIdRequiredCredit"));
  }

  const paymentStatus = amountPaid >= total ? "paid" : amountPaid > 0 ? "partial" : "credit";
  const number = await nextServiceOrderNumber(db);

  const order = await db
    .insert(schema.serviceOrders)
    .values({
      number,
      customerId,
      userId: input.userId,
      storeId: input.storeId,
      subtotal,
      discount,
      taxTotal,
      total,
      paymentStatus,
      promisedDate: input.promisedDate,
      notes: input.notes,
    })
    .returning()
    .get();

  for (const item of input.items) {
    await db.insert(schema.serviceOrderItems).values({
      serviceOrderId: order.id,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discount: item.discount ?? 0,
      taxRate: item.taxRate ?? 0,
      total: computeItemTotal(item),
    });
  }

  if (amountPaid > 0) {
    await db.insert(schema.payments).values({
      referenceType: "service_order",
      referenceId: order.id,
      method: input.paymentMethod,
      amount: amountPaid,
      receivedBy: input.userId,
      storeId: input.storeId,
    });
  }

  if (amountPaid < total) {
    await db.insert(schema.customerCredits).values({
      customerId: customerId!,
      serviceOrderId: order.id,
      storeId: input.storeId,
      originalAmount: total - amountPaid,
      remainingBalance: total - amountPaid,
      status: "open",
    });
  }

  if (customerId) {
    const ratio = (await getSettings(db)).loyaltyPointsRatio;
    await earnPoints(db, { customerId, amount: total, saleId: order.id, ratio });
  }

  await logAction(db, {
    userId: input.userId,
    action: "create_service_order",
    entity: "service_order",
    entityId: order.id,
    metadata: { number: order.number, total, paymentStatus },
  });

  return order;
}

export interface ServiceOrderFilters {
  storeId?: number;
  from?: string; // "YYYY-MM-DD"
  to?: string;
}

export async function listServiceOrders(db: Database, filters: ServiceOrderFilters = {}) {
  const conditions = [];
  if (filters.storeId) conditions.push(eq(schema.serviceOrders.storeId, filters.storeId));
  if (filters.from) conditions.push(gte(schema.serviceOrders.createdAt, `${filters.from.slice(0, 10)} 00:00:00`));
  if (filters.to) conditions.push(lte(schema.serviceOrders.createdAt, `${filters.to.slice(0, 10)} 23:59:59`));

  const query = db.select().from(schema.serviceOrders).orderBy(desc(schema.serviceOrders.id));
  return conditions.length > 0 ? query.where(and(...conditions)) : query;
}

export async function listServiceOrderItems(db: Database, serviceOrderId: number) {
  return db
    .select()
    .from(schema.serviceOrderItems)
    .where(eq(schema.serviceOrderItems.serviceOrderId, serviceOrderId));
}

// Une seule ligne de paiement par ticket à la création (voir
// createServiceOrder) — même raisonnement que SalesService.getSalePayment.
export async function getServiceOrderPayment(db: Database, serviceOrderId: number) {
  return db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.referenceType, "service_order"), eq(schema.payments.referenceId, serviceOrderId)))
    .get();
}

type ServiceOrderItem = typeof schema.serviceOrderItems.$inferSelect;

export type ServiceOrderAggregateStatus =
  | "received"
  | "in_progress"
  | "ready"
  | "partially_picked_up"
  | "closed";

export interface ServiceOrderStatusSummary {
  status: ServiceOrderAggregateStatus;
  pickedUpCount: number;
  totalCount: number;
}

// Statut résumé calculé à la volée à partir des lignes — pas de colonne
// dénormalisée à maintenir en synchro sur service_orders.
export function deriveOrderStatus(items: ServiceOrderItem[]): ServiceOrderStatusSummary {
  const totalCount = items.length;
  const pickedUpCount = items.filter((i) => i.status === "picked_up").length;

  let status: ServiceOrderAggregateStatus;
  if (totalCount > 0 && pickedUpCount === totalCount) {
    status = "closed";
  } else if (pickedUpCount > 0) {
    status = "partially_picked_up";
  } else if (items.some((i) => i.status === "ready")) {
    status = "ready";
  } else if (items.some((i) => i.status === "in_progress")) {
    status = "in_progress";
  } else {
    status = "received";
  }

  return { status, pickedUpCount, totalCount };
}

export type ServiceOrderItemStatus = "received" | "in_progress" | "ready" | "picked_up";

export interface UpdateServiceOrderItemStatusInput {
  itemId: number;
  status: ServiceOrderItemStatus;
  userId: number;
}

export async function updateServiceOrderItemStatus(
  db: Database,
  input: UpdateServiceOrderItemStatusInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_service_orders");
  const now = new Date().toISOString();

  const item = await db
    .update(schema.serviceOrderItems)
    .set({
      status: input.status,
      pickedUpAt: input.status === "picked_up" ? now : null,
    })
    .where(eq(schema.serviceOrderItems.id, input.itemId))
    .returning()
    .get();

  if (!item) {
    throw new Error(t("coreErrors.serviceOrders.itemNotFound"));
  }

  const siblings = await listServiceOrderItems(db, item.serviceOrderId);
  const allPickedUp = siblings.every((i) => i.status === "picked_up");
  await db
    .update(schema.serviceOrders)
    .set({ closedAt: allPickedUp ? now : null })
    .where(eq(schema.serviceOrders.id, item.serviceOrderId));

  await logAction(db, {
    userId: input.userId,
    action: "update_service_order_item_status",
    entity: "service_order_item",
    entityId: input.itemId,
    metadata: { status: input.status },
  });

  return item;
}

// Correction d'un ticket déjà créé (client, date prévue, notes) — réservé à
// Admin/Gérant (permission edit_service_orders), distinct du suivi quotidien
// (statut/encaissement) accessible à tous les rôles qui gèrent les tickets.
export interface UpdateServiceOrderInput {
  customerId?: number | null;
  promisedDate?: string | null;
  notes?: string | null;
}

export async function updateServiceOrder(
  db: Database,
  orderId: number,
  input: UpdateServiceOrderInput,
  userId: number,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "edit_service_orders");
  const order = await db
    .update(schema.serviceOrders)
    .set(input)
    .where(eq(schema.serviceOrders.id, orderId))
    .returning()
    .get();

  await logAction(db, {
    userId,
    action: "update_service_order",
    entity: "service_order",
    entityId: orderId,
  });

  return order;
}

export interface UpdateServiceOrderItemInput {
  description?: string;
  quantity?: number;
  unitPrice?: number;
  discount?: number;
  taxRate?: number;
}

// Corrige une ligne (mauvaise description, mauvais prix...) et recalcule les
// totaux de l'ordre à partir de toutes ses lignes sœurs — mais ne rejoue pas
// les paiements/créances déjà enregistrés si le total change après coup (voir
// le plan) : à ajuster manuellement dans Créances si un solde était déjà fixé
// avant la correction.
export async function updateServiceOrderItem(
  db: Database,
  itemId: number,
  input: UpdateServiceOrderItemInput,
  userId: number,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "edit_service_orders");
  const current = await db
    .select()
    .from(schema.serviceOrderItems)
    .where(eq(schema.serviceOrderItems.id, itemId))
    .get();
  if (!current) {
    throw new Error(t("coreErrors.serviceOrders.itemNotFound"));
  }

  const merged: ServiceOrderItemInput = {
    description: input.description ?? current.description,
    quantity: input.quantity ?? current.quantity,
    unitPrice: input.unitPrice ?? current.unitPrice,
    discount: input.discount ?? current.discount,
    taxRate: input.taxRate ?? current.taxRate,
  };
  const total = computeItemTotal(merged);

  await db
    .update(schema.serviceOrderItems)
    .set({ ...merged, total })
    .where(eq(schema.serviceOrderItems.id, itemId));

  const siblings = await listServiceOrderItems(db, current.serviceOrderId);
  const subtotal = siblings.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const taxTotal = siblings.reduce((sum, i) => {
    const gross = i.quantity * i.unitPrice - i.discount;
    return sum + computeTaxAmount(gross, i.taxRate);
  }, 0);
  const orderTotal = siblings.reduce((sum, i) => sum + i.total, 0);

  await db
    .update(schema.serviceOrders)
    .set({ subtotal, taxTotal, total: orderTotal })
    .where(eq(schema.serviceOrders.id, current.serviceOrderId));

  await logAction(db, {
    userId,
    action: "update_service_order_item",
    entity: "service_order_item",
    entityId: itemId,
  });
}
