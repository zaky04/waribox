import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// File d'attente des ventes en attente de certification FNE (Facture
// Normalisée Électronique, Côte d'Ivoire — voir CLAUDE.md) sur CET appareil.
// Une ligne est ajoutée juste après la création d'une vente (si la FNE est
// activée) et retirée seulement après une certification réussie ou un échec
// définitif jugé non réessayable — un échec réseau/serveur laisse la ligne en
// place pour une nouvelle tentative (voir apps/web/src/features/fne/useFneQueue.ts).
export const fneQueue = sqliteTable("__fne_queue", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  saleId: integer("sale_id").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastAttemptAt: text("last_attempt_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
