import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  parentId: integer("parent_id"),
});

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  categoryId: integer("category_id").references(() => categories.id),
  baseSku: text("base_sku"),
  unit: text("unit").notNull().default("unite"), // 'unite' | 'kg' | 'litre' | ...
  hasVariants: integer("has_variants", { mode: "boolean" }).notNull().default(false),
  // JSON: [{ "key": "taille", "label": "Taille" }, { "key": "couleur", "label": "Couleur" }]
  // ou [{ "key": "auteur" }, { "key": "isbn" }] selon le secteur
  attributeSchema: text("attribute_schema"),
  trackExpiry: integer("track_expiry", { mode: "boolean" }).notNull().default(false),
  purchasePrice: real("purchase_price").notNull().default(0),
  salePrice: real("sale_price").notNull().default(0),
  taxRate: real("tax_rate"),
  lowStockThreshold: integer("low_stock_threshold").notNull().default(5),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const productVariants = sqliteTable("product_variants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id")
    .notNull()
    .references(() => products.id),
  sku: text("sku"),
  barcode: text("barcode").unique(),
  // JSON: { "taille": "M", "couleur": "Rouge" } ou { "isbn": "...", "auteur": "..." }
  attributes: text("attributes"),
  priceOverride: real("price_override"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});
