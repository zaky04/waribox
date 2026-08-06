import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { products } from "./products";

// Remise programmée, appliquée automatiquement aux ventes pendant la
// fenêtre startDate → endDate (dates incluses), sans saisie manuelle du
// caissier — voir SalesService/PromotionsService pour l'application au
// panier. `scope` fixe à la création si la remise porte sur des produits
// précis (voir promotionProducts) ou sur le total de la facture — jamais
// les deux en même temps, pour éviter toute ambiguïté de calcul.
export const promotions = sqliteTable("promotions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  scope: text("scope").notNull(), // 'product' | 'invoice'
  discountPercent: real("discount_percent").notNull(),
  startDate: text("start_date").notNull(), // "YYYY-MM-DD", incluse
  endDate: text("end_date").notNull(), // "YYYY-MM-DD", incluse
  // Coupure manuelle indépendante de la fenêtre de dates — permet de
  // suspendre une promotion sans attendre la fin de sa période ni la
  // supprimer (et perdre l'historique de ce qui a été appliqué).
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Produits concernés par une promotion scope="product" — sans ligne ici,
// une promotion "product" ne s'applique à rien (jamais interprétée comme
// "tous les produits").
export const promotionProducts = sqliteTable("promotion_products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  promotionId: integer("promotion_id")
    .notNull()
    .references(() => promotions.id),
  productId: integer("product_id")
    .notNull()
    .references(() => products.id),
});
