import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { customers } from "./customers";
import { productVariants } from "./products";
import { stores } from "./stores";
import { users } from "./users";

// Ordre de service (dépôt/retrait différé) — pressing, cordonnerie, couture,
// réparation, photo... Distinct de `sales` : pas de stock à décrémenter, et
// chaque article suit son propre cycle de vie jusqu'au retrait (voir
// service_order_items.status), alors qu'une vente est encaissée et close en
// un seul geste.
export const serviceOrders = sqliteTable("service_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  number: text("number").notNull().unique(), // ex: TCK-2026-000123
  customerId: integer("customer_id").references(() => customers.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  storeId: integer("store_id").references(() => stores.id),
  subtotal: real("subtotal").notNull(),
  discount: real("discount").notNull().default(0),
  taxTotal: real("tax_total").notNull().default(0),
  total: real("total").notNull(),
  paymentStatus: text("payment_status").notNull().default("paid"), // 'paid' | 'partial' | 'credit'
  promisedDate: text("promised_date"),
  notes: text("notes"),
  closedAt: text("closed_at"), // renseigné quand tous les articles sont retirés
  // Annulation formelle (jamais de suppression) : motif obligatoire et responsable.
  cancelledAt: text("cancelled_at"),
  cancelReason: text("cancel_reason"),
  cancelledBy: integer("cancelled_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const serviceOrderItems = sqliteTable("service_order_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  serviceOrderId: integer("service_order_id")
    .notNull()
    .references(() => serviceOrders.id),
  // Nullable : la saisie d'un article de ticket de service est manuelle
  // (description libre + prix), pas liée au catalogue Produits — un pressing
  // n'a pas de catalogue produits. Conservé pour une éventuelle réutilisation
  // future, mais jamais renseigné aujourd'hui.
  variantId: integer("variant_id").references(() => productVariants.id),
  description: text("description").notNull(), // détail libre : modèle d'appareil, description du vêtement...
  quantity: real("quantity").notNull(),
  unitPrice: real("unit_price").notNull(),
  discount: real("discount").notNull().default(0),
  taxRate: real("tax_rate").notNull().default(0),
  total: real("total").notNull(),
  status: text("status").notNull().default("received"), // 'received' | 'in_progress' | 'ready' | 'picked_up'
  pickedUpAt: text("picked_up_at"),
  // Prix de référence du tarif choisi à la saisie (NULL = saisie manuelle) :
  // copié pour rester juste même si le tarif change ensuite.
  tariffPrice: real("tariff_price"),
});

// Tarifs de services — FACULTATIF : le propriétaire y enregistre ses services
// courants (repassage, cordonnerie, réparation...) pour que le prix soit
// contrôlé ; sans tarif, la saisie reste entièrement manuelle.
export const serviceTariffs = sqliteTable("service_tariffs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  price: real("price").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
