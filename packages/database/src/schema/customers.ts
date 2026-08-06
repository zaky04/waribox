import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const customers = sqliteTable("customers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fullName: text("full_name").notNull(),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  loyaltyPoints: real("loyalty_points").notNull().default(0),
  // Cumul à vie des points gagnés (jamais décrémenté par un rachat,
  // contrairement à loyaltyPoints) — sert de seule base au calcul du palier
  // (Bronze/Argent/Or), qui doit refléter l'historique d'achat du client et
  // non son solde dépensable du moment (voir LoyaltyService.computeTier).
  lifetimeLoyaltyPoints: real("lifetime_loyalty_points").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
