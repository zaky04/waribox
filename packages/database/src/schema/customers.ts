import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const customers = sqliteTable("customers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Voir CLAUDE.md, mode réseau Phase 2 : renseigné uniquement pour un
  // client de passage créé pendant une vente (offline-capable, voir
  // SalesService.createSale) — un client créé depuis la page Clients reste
  // sans syncId (cette création-là exige déjà d'être connecté au Master,
  // voir la Phase 3 à venir).
  syncId: text("sync_id"),
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
  // Plafond de crédit de ce client (NULL = plafond par défaut des paramètres).
  creditLimit: real("credit_limit"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
