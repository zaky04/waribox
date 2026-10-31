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
  // Fiche médicament (pack Pharmacie) — tous facultatifs. La DCI (dénomination
  // commune internationale = principe actif) + le dosage servent à proposer un
  // équivalent quand un produit est en rupture (voir findEquivalents).
  dci: text("dci"),
  dosage: text("dosage"), // ex: "500 mg"
  dosageForm: text("dosage_form"), // comprimé, sirop, injectable...
  laboratory: text("laboratory"),
  // Délivrance sur ordonnance : la vente exige alors une référence d'ordonnance.
  requiresPrescription: integer("requires_prescription", { mode: "boolean" }).notNull().default(false),
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
  // Présentation conditionnée : une variante « plaquette » pointe vers sa variante
  // « boîte » (même produit) et le nombre d'unités qu'une boîte contient — voir
  // StockService.breakDownPack (action « Détailler »). NULL = pas de lien.
  parentVariantId: integer("parent_variant_id"),
  unitsPerParent: real("units_per_parent"),
});
