import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { customers } from "./customers";
import { sales } from "./sales";
import { serviceOrders } from "./service-orders";

export const customerCredits = sqliteTable("customer_credits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customers.id),
  saleId: integer("sale_id").references(() => sales.id),
  // Nullable au même titre que saleId : une créance vient soit d'une vente,
  // soit d'un ordre de service, jamais des deux.
  serviceOrderId: integer("service_order_id").references(() => serviceOrders.id),
  originalAmount: real("original_amount").notNull(),
  remainingBalance: real("remaining_balance").notNull(),
  dueDate: text("due_date"),
  status: text("status").notNull().default("open"), // 'open' | 'partial' | 'settled'
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const creditRepayments = sqliteTable("credit_repayments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  creditId: integer("credit_id")
    .notNull()
    .references(() => customerCredits.id),
  amount: real("amount").notNull(),
  method: text("method"),
  paidAt: text("paid_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
