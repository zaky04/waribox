import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./users";

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: integer("entity_id"),
  metadata: text("metadata"), // JSON diff avant/après
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const backups = sqliteTable("backups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  destination: text("destination").notNull(), // 'local' | 'google_drive'
  fileRef: text("file_ref"),
  status: text("status"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
