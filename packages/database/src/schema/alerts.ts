import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Alertes au patron (infrastructure, préfixe `__` comme les tables du mode réseau : jamais effacées ni copiées
// quand l'appareil rejoint un Maître). Chaque appareil tient les siennes.

// File et historique des alertes : une ligne par message à faire parvenir au patron. Elle est créée dès que
// l'alerte est détectée (même sans canal automatique configuré : l'écran Contrôles propose alors l'envoi par
// WhatsApp en un geste) et marquée envoyée quand le message est parti.
export const alertOutbox = sqliteTable("__alert_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Identité de l'alerte (évite d'envoyer deux fois la même).
  key: text("key").notNull(),
  severity: text("severity").notNull(), // 'info' | 'warning' | 'danger'
  text: text("text").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  sentAt: text("sent_at"),
  channel: text("channel"), // 'url' | 'whatsapp'
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
});

// Repères internes : dernière ligne d'audit examinée, dernière analyse globale, résumé du jour déjà envoyé...
export const alertState = sqliteTable("__alert_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Relances de créances déjà envoyées (voir ReminderService) : une ligne par créance et par étape de retard.
export const creditReminders = sqliteTable(
  "__credit_reminders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    creditId: integer("credit_id").notNull(),
    step: integer("step").notNull(), // jours de retard de l'étape (1, 7, 15, 30)
    channel: text("channel"),
    sentAt: text("sent_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({ unique: uniqueIndex("uq_credit_reminders").on(table.creditId, table.step) }),
);
