import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { customers } from "./customers";
import { sales } from "./sales";
import { serviceOrders } from "./service-orders";
import { stores } from "./stores";

export const customerCredits = sqliteTable("customer_credits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Voir CLAUDE.md, mode réseau Phase 2 — même rôle que sales.syncId.
  syncId: text("sync_id"),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customers.id),
  saleId: integer("sale_id").references(() => sales.id),
  // Nullable au même titre que saleId : une créance vient soit d'une vente,
  // soit d'un ordre de service, jamais des deux.
  serviceOrderId: integer("service_order_id").references(() => serviceOrders.id),
  // Dénormalisé depuis la vente/l'ordre de service d'origine à la création.
  storeId: integer("store_id").references(() => stores.id),
  originalAmount: real("original_amount").notNull(),
  remainingBalance: real("remaining_balance").notNull(),
  dueDate: text("due_date"),
  status: text("status").notNull().default("open"), // 'open' | 'partial' | 'settled'
  // Responsable ayant approuvé cette créance quand elle dépassait le seuil.
  approvedBy: integer("approved_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const creditRepayments = sqliteTable("credit_repayments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  creditId: integer("credit_id")
    .notNull()
    .references(() => customerCredits.id),
  amount: real("amount").notNull(),
  method: text("method"),
  // Qui a encaissé ce règlement, et dans quelle boutique — nécessaires pour le
  // rapprocher du tiroir-caisse et le rattacher à une personne.
  receivedBy: integer("received_by"),
  storeId: integer("store_id"),
  paidAt: text("paid_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
