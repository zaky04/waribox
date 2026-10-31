import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { productVariants } from "./products";
import { stores } from "./stores";
import { suppliers } from "./suppliers";
import { users } from "./users";

export const purchases = sqliteTable("purchases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  number: text("number").notNull().unique(),
  supplierId: integer("supplier_id")
    .notNull()
    .references(() => suppliers.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  storeId: integer("store_id").references(() => stores.id),
  status: text("status").notNull().default("received"), // 'ordered' | 'received' | 'cancelled'
  total: real("total").notNull(),
  // Numéro de la facture/du bon du fournisseur, pour le rapprochement.
  invoiceReference: text("invoice_reference"),
  // Renseignés à la réception contrôlée (achats en deux temps, voir
  // business_settings.requirePurchaseReceipt).
  receivedAt: text("received_at"),
  receivedBy: integer("received_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const purchaseItems = sqliteTable("purchase_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purchaseId: integer("purchase_id")
    .notNull()
    .references(() => purchases.id),
  variantId: integer("variant_id")
    .notNull()
    .references(() => productVariants.id),
  quantity: real("quantity").notNull(),
  unitCost: real("unit_cost").notNull(),
  // Quantité réellement comptée à la réception (NULL tant que non reçue).
  receivedQuantity: real("received_quantity"),
  // Dernier coût connu de cette variante au moment de l'achat, et alerte si la
  // hausse dépassait le seuil des paramètres.
  previousUnitCost: real("previous_unit_cost"),
  priceAlert: integer("price_alert", { mode: "boolean" }).notNull().default(false),
});

export const supplierDebts = sqliteTable("supplier_debts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  supplierId: integer("supplier_id")
    .notNull()
    .references(() => suppliers.id),
  purchaseId: integer("purchase_id").references(() => purchases.id),
  // Dénormalisé depuis purchases.storeId à la création — évite une jointure
  // pour filtrer les dettes par boutique.
  storeId: integer("store_id").references(() => stores.id),
  originalAmount: real("original_amount").notNull(),
  remainingBalance: real("remaining_balance").notNull(),
  dueDate: text("due_date"),
  status: text("status").notNull().default("open"), // 'open' | 'partial' | 'settled'
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const supplierDebtPayments = sqliteTable("supplier_debt_payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  debtId: integer("debt_id")
    .notNull()
    .references(() => supplierDebts.id),
  amount: real("amount").notNull(),
  paidBy: integer("paid_by"),
  paidAt: text("paid_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
