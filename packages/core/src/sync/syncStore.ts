import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { asc, eq, gt, isNull } from "drizzle-orm";
import type { SyncEvent } from "./syncEvents";

// Accès aux tables d'infrastructure du mode réseau (__sync_log/__sync_outbox/
// __sync_state, voir packages/database/src/schema/sync.ts) — centralisé ici
// pour que apps/web (qui orchestre le réseau) n'ait jamais à écrire de
// requête drizzle brute sur ces tables, même patron que le reste de
// packages/core vis-à-vis de l'UI.

export interface StoredSyncEvent {
  seq: number;
  event: SyncEvent;
}

/** Master uniquement : ajoute un événement accepté au journal faisant autorité, lui assigne son `seq`. */
export async function appendToSyncLog(db: Database, event: SyncEvent, originDeviceId: string): Promise<number> {
  const row = await db
    .insert(schema.syncLog)
    .values({ eventType: event.type, payloadJson: JSON.stringify(event), originDeviceId })
    .returning()
    .get();
  return row.seq;
}

/** Master uniquement : tout événement postérieur à `sinceSeq` (0 = tout l'historique) — pour le rattrapage d'un Worker qui se reconnecte. */
export async function listSyncLogSince(db: Database, sinceSeq: number): Promise<StoredSyncEvent[]> {
  const rows = await db.select().from(schema.syncLog).where(gt(schema.syncLog.seq, sinceSeq)).orderBy(asc(schema.syncLog.seq));
  return rows.map((row) => ({ seq: row.seq, event: JSON.parse(row.payloadJson) as SyncEvent }));
}

/** Master uniquement : le plus haut `seq` connu, 0 si le journal est vide. */
export async function getMaxSyncSeq(db: Database): Promise<number> {
  const rows = await db.select().from(schema.syncLog).orderBy(asc(schema.syncLog.seq));
  return rows.length > 0 ? rows[rows.length - 1]!.seq : 0;
}

/** Worker uniquement : met en file un événement créé localement, en attente d'envoi au Master. */
export async function enqueueOutbox(db: Database, event: SyncEvent): Promise<number> {
  const row = await db.insert(schema.syncOutbox).values({ eventJson: JSON.stringify(event) }).returning().get();
  return row.id;
}

/** Worker uniquement : tout ce qui n'a pas encore été confirmé reçu par le Master (voir markOutboxSent). */
export async function listPendingOutbox(db: Database): Promise<Array<{ id: number; event: SyncEvent }>> {
  const rows = await db.select().from(schema.syncOutbox).where(isNull(schema.syncOutbox.sentAt)).orderBy(asc(schema.syncOutbox.id));
  return rows.map((row) => ({ id: row.id, event: JSON.parse(row.eventJson) as SyncEvent }));
}

/** Worker uniquement : à appeler seulement après un `syncAck` confirmé — jamais au simple envoi. */
export async function markOutboxSent(db: Database, id: number): Promise<void> {
  await db.delete(schema.syncOutbox).where(eq(schema.syncOutbox.id, id)).run();
}

const LAST_APPLIED_SEQ_KEY = "lastAppliedSeq";

/** Worker uniquement : `null` = jamais synchronisé (déclenche la demande d'instantané, voir snapshot.ts). */
export async function getLastAppliedSeq(db: Database): Promise<number | null> {
  const row = await db.select().from(schema.syncState).where(eq(schema.syncState.key, LAST_APPLIED_SEQ_KEY)).get();
  return row ? Number(row.value) : null;
}

/** Worker uniquement : avance le repère de progression après application réussie d'un lot d'événements. */
export async function setLastAppliedSeq(db: Database, seq: number): Promise<void> {
  const existing = await db.select().from(schema.syncState).where(eq(schema.syncState.key, LAST_APPLIED_SEQ_KEY)).get();
  if (existing) {
    await db.update(schema.syncState).set({ value: String(seq) }).where(eq(schema.syncState.key, LAST_APPLIED_SEQ_KEY)).run();
  } else {
    await db.insert(schema.syncState).values({ key: LAST_APPLIED_SEQ_KEY, value: String(seq) }).run();
  }
}
