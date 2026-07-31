import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { productVariants } from "./products";
import { users } from "./users";

export const stockLocations = sqliteTable("stock_locations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull().unique(), // 'reserve' | 'surface_vente'
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
  movementType: text("movement_type").notNull(), // 'purchase' | 'sale' | 'transfer' | 'adjustment' | 'loss'
  referenceType: text("reference_type"), // 'sale' | 'purchase' | 'manual'
  referenceId: integer("reference_id"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
