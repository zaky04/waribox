import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { stores } from "./stores";
import { users } from "./users";

export const cashSessions = sqliteTable("cash_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  // Nullable au niveau colonne (ajoutée par migration, rétro-remplie pour les
  // lignes existantes) — toujours renseigné pour toute session ouverte après
  // l'introduction du multi-boutique. Un même utilisateur peut avoir une
  // session ouverte par boutique.
  storeId: integer("store_id").references(() => stores.id),
  openingAmount: real("opening_amount").notNull(),
  closingAmount: real("closing_amount"),
  expectedAmount: real("expected_amount"),
  openedAt: text("opened_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  closedAt: text("closed_at"),
});
