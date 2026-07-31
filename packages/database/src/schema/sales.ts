import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { customers } from "./customers";
import { productVariants } from "./products";
import { users } from "./users";

export const sales = sqliteTable("sales", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  number: text("number").notNull().unique(), // ex: VTE-2026-000123
  customerId: integer("customer_id").references(() => customers.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  saleMode: text("sale_mode").notNull(), // 'pos' | 'form'
  status: text("status").notNull().default("completed"), // 'draft' | 'completed' | 'cancelled' | 'refunded'
  subtotal: real("subtotal").notNull(),
  discount: real("discount").notNull().default(0),
  taxTotal: real("tax_total").notNull().default(0),
  total: real("total").notNull(),
  paymentStatus: text("payment_status").notNull().default("paid"), // 'paid' | 'partial' | 'credit'
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const saleItems = sqliteTable("sale_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  saleId: integer("sale_id")
    .notNull()
    .references(() => sales.id),
  variantId: integer("variant_id")
    .notNull()
    .references(() => productVariants.id),
  quantity: real("quantity").notNull(),
  unitPrice: real("unit_price").notNull(),
  discount: real("discount").notNull().default(0),
  taxRate: real("tax_rate").notNull().default(0),
  total: real("total").notNull(),
});

export const payments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  referenceType: text("reference_type").notNull(), // 'sale' | 'purchase' | 'credit_repayment' | 'debt_payment'
  referenceId: integer("reference_id").notNull(),
  method: text("method").notNull(), // 'cash' | 'card' | 'mobile_money' | 'credit'
  amount: real("amount").notNull(),
  receivedBy: integer("received_by").references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
