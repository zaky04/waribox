import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { customers } from "./customers";

export const loyaltyTransactions = sqliteTable("loyalty_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customers.id),
  pointsDelta: real("points_delta").notNull(),
  reason: text("reason"), // 'purchase' | 'redemption' | 'manual_adjustment'
  referenceId: integer("reference_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
