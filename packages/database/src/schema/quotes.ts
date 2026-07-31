import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { customers } from "./customers";
import { sales } from "./sales";

export const quotes = sqliteTable("quotes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  number: text("number").notNull().unique(),
  customerId: integer("customer_id").references(() => customers.id),
  status: text("status").notNull().default("pending"), // 'pending' | 'accepted' | 'expired' | 'converted'
  validUntil: text("valid_until"),
  total: real("total").notNull(),
  convertedSaleId: integer("converted_sale_id").references(() => sales.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
