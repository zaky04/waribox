import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const suppliers = sqliteTable("suppliers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  phone: text("phone"),
  contactPerson: text("contact_person"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
