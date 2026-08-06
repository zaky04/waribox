import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { saleItems, sales } from "./sales";
import { users } from "./users";

// Un remboursement porte toujours sur une vente déjà encaissée (jamais sur un
// devis ou un ticket de service) — annule tout ou partie de ses lignes,
// remet éventuellement la quantité en stock, et journalise l'argent rendu au
// client via payments (referenceType "refund").
export const refunds = sqliteTable("refunds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  saleId: integer("sale_id")
    .notNull()
    .references(() => sales.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  reason: text("reason"),
  // Méthode de restitution de l'argent — indépendante de la méthode de
  // paiement d'origine (ex: vente payée par carte, remboursée en espèces).
  method: text("method").notNull(),
  subtotal: real("subtotal").notNull(),
  taxTotal: real("tax_total").notNull().default(0),
  total: real("total").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const refundItems = sqliteTable("refund_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  refundId: integer("refund_id")
    .notNull()
    .references(() => refunds.id),
  saleItemId: integer("sale_item_id")
    .notNull()
    .references(() => saleItems.id),
  quantity: real("quantity").notNull(),
  unitPrice: real("unit_price").notNull(),
  taxRate: real("tax_rate").notNull().default(0),
  total: real("total").notNull(),
  // Si vrai, la quantité a été réintégrée au stock vendable (recordMovement
  // movementType "return") — faux pour un article rendu défectueux/détruit.
  restocked: integer("restocked", { mode: "boolean" }).notNull().default(false),
});
