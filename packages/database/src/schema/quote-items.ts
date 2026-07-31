import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { productVariants } from "./products";
import { quotes } from "./quotes";

export const quoteItems = sqliteTable("quote_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  quoteId: integer("quote_id")
    .notNull()
    .references(() => quotes.id),
  variantId: integer("variant_id")
    .notNull()
    .references(() => productVariants.id),
  quantity: real("quantity").notNull(),
  unitPrice: real("unit_price").notNull(),
  discount: real("discount").notNull().default(0),
  taxRate: real("tax_rate").notNull().default(0),
  total: real("total").notNull(),
});
