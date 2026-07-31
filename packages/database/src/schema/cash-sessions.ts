import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./users";

export const cashSessions = sqliteTable("cash_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  openingAmount: real("opening_amount").notNull(),
  closingAmount: real("closing_amount"),
  expectedAmount: real("expected_amount"),
  openedAt: text("opened_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  closedAt: text("closed_at"),
});
