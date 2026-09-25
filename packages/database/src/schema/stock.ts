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
  // Voir CLAUDE.md, mode réseau Phase 2 — même rôle que sales.syncId.
  syncId: text("sync_id"),
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
  // Voir CLAUDE.md, mode réseau Phase 2 — même rôle que sales.syncId.
  syncId: text("sync_id"),
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
  // Motif libre saisi avec un mouvement manuel, et responsable l'ayant approuvé
  // quand il dépassait le seuil.
  note: text("note"),
  approvedBy: integer("approved_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Inventaire physique : on fige la quantité théorique (system_quantity) au
// démarrage, on saisit les quantités comptées SANS les voir, puis la clôture
// calcule l'écart et régularise le stock.
export const stockCounts = sqliteTable("stock_counts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("store_id").references(() => stores.id),
  locationId: integer("location_id")
    .notNull()
    .references(() => stockLocations.id),
  status: text("status").notNull().default("open"), // 'open' | 'closed'
  startedBy: integer("started_by")
    .notNull()
    .references(() => users.id),
  closedBy: integer("closed_by").references(() => users.id),
  approvedBy: integer("approved_by"),
  note: text("note"),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  closedAt: text("closed_at"),
});

export const stockCountLines = sqliteTable("stock_count_lines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  countId: integer("count_id")
    .notNull()
    .references(() => stockCounts.id),
  variantId: integer("variant_id")
    .notNull()
    .references(() => productVariants.id),
  systemQuantity: real("system_quantity").notNull(),
  countedQuantity: real("counted_quantity"),
  // Coût unitaire au démarrage, pour valoriser l'écart.
  unitCost: real("unit_cost"),
});
