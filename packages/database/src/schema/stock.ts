import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { productVariants } from "./products";
import { stores } from "./stores";
import { users } from "./users";

export const stockLocations = sqliteTable("stock_locations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  // Reste globalement unique pour compat avec les bases mono-boutique
  // existantes ('reserve'/'surface_vente' pour la première boutique) — toute
  // boutique additionnelle reçoit un type suffixé ("reserve#<storeId>"), voir
  // StockService.ensureLocationsForStore.
  type: text("type").notNull().unique(),
  // Nullable au niveau colonne (ajoutée par migration, rétro-remplie vers la
  // boutique par défaut) — toujours renseigné en pratique.
  storeId: integer("store_id").references(() => stores.id),
});

export const stockBatches = sqliteTable("stock_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  variantId: integer("variant_id")
    .notNull()
    .references(() => productVariants.id),
  locationId: integer("location_id")
    .notNull()
    .references(() => stockLocations.id),
  lotNumber: text("lot_number"),
  expiryDate: text("expiry_date"),
  quantity: real("quantity").notNull().default(0),
  // Coût d'achat unitaire de ce lot — NULL pour les lots créés avant
  // l'introduction de ce champ, ou via une entrée de stock manuelle sans
  // coût renseigné (voir StockPage "Entrée de stock"). ReportsService s'en
  // sert pour calculer la marge réelle vendue ; repli sur
  // products.purchasePrice quand NULL (voir son commentaire).
  unitCost: real("unit_cost"),
});

// Grand livre des mouvements de stock : le solde courant se calcule par
// SUM(quantityDelta) GROUP BY variantId, locationId — jamais de colonne mutable.
export const stockMovements = sqliteTable("stock_movements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  variantId: integer("variant_id")
    .notNull()
    .references(() => productVariants.id),
  locationId: integer("location_id")
    .notNull()
    .references(() => stockLocations.id),
  batchId: integer("batch_id").references(() => stockBatches.id),
  quantityDelta: real("quantity_delta").notNull(),
  movementType: text("movement_type").notNull(), // 'purchase' | 'sale' | 'transfer' | 'adjustment' | 'loss' | 'return'
  referenceType: text("reference_type"), // 'sale' | 'purchase' | 'manual'
  referenceId: integer("reference_id"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
