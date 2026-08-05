import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Point de vente physique ("succursale") — stock et ventes sont scopés par
// storeId ; produits/clients/fournisseurs restent partagés entre boutiques.
// Une boutique par défaut existe toujours, même si le multi-boutique est
// désactivé dans les paramètres (voir business_settings.multiStoreEnabled) —
// ça garantit que stockLocations/sales/cashSessions/payments ont toujours un
// storeId valide, sans code séparé pour le cas mono-boutique.
export const stores = sqliteTable("stores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  address: text("address"),
  phone: text("phone"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
