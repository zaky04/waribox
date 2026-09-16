import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Tables d'infrastructure du mode réseau (Phase 2 — voir CLAUDE.md), pas des
// données métier : préfixées `__sync_` comme `__migrations`, jamais exposées
// dans un écran de saisie. Présentes sur tout appareil (Master ou Worker,
// voire Solo) via le bootstrap partagé, mais chaque table n'est réellement
// peuplée que par le rôle concerné (voir leur commentaire).

// Journal append-only faisant autorité, tenu par le Master : chaque
// événement de synchronisation accepté (créé localement ou reçu d'un
// Worker) y reçoit un `seq` qui sert de repère de progression aux Workers
// (voir `__sync_state.lastAppliedSeq`). Un Worker n'écrit jamais ici lui-même
// — il ne fait que recevoir des lignes déjà numérotées par le Master.
export const syncLog = sqliteTable("__sync_log", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull(),
  originDeviceId: text("origin_device_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// File d'attente des événements créés localement sur CET appareil, en
// attente d'envoi au Master — pertinente pour un Worker (le Master n'a pas
// besoin d'attendre une connexion pour appliquer ses propres écritures).
// Persistée en SQLite (pas en mémoire) : un Worker hors ligne pendant des
// heures, y compris après un redémarrage de l'application, ne doit rien
// perdre. Une ligne est retirée seulement après confirmation (`syncAck`) du
// Master — jamais à l'envoi seul, qui peut échouer en cours de route.
export const syncOutbox = sqliteTable("__sync_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventJson: text("event_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  sentAt: text("sent_at"),
});

// Repère de progression de CET appareil dans le journal du Master
// (`__sync_log.seq`) — une seule ligne, clé fixe. Absent (aucune ligne)
// signifie "jamais synchronisé" : c'est ce qui déclenche la demande
// d'instantané initial du catalogue plutôt qu'un simple rattrapage
// incrémental (voir snapshot.ts).
export const syncState = sqliteTable("__sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
