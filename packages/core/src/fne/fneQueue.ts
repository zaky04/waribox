import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import type { FneCertificationResult } from "./fneTypes";

// Accès à la file d'attente de certification FNE (__fne_queue, voir
// packages/database/src/schema/fne.ts) — centralisé ici, même principe que
// packages/core/src/sync/syncStore.ts pour le mode réseau.

/** Met une vente en file d'attente de certification — appelé juste après un `createSale` réussi si la FNE est active. */
export async function enqueueFneCertification(db: Database, saleId: number): Promise<void> {
  await db.update(schema.sales).set({ fneStatus: "pending" }).where(eq(schema.sales.id, saleId)).run();
  await db.insert(schema.fneQueue).values({ saleId }).run();
}

export interface PendingFneCertification {
  queueId: number;
  saleId: number;
  attemptCount: number;
}

/** Tout ce qui attend encore d'être certifié (ou re-tenté après un échec) sur cet appareil. */
export async function listPendingFneCertifications(db: Database): Promise<PendingFneCertification[]> {
  const rows = await db.select().from(schema.fneQueue);
  return rows.map((row) => ({ queueId: row.id, saleId: row.saleId, attemptCount: row.attemptCount }));
}

/** Certification réussie : écrit le résultat sur la vente, retire la ligne de la file. */
export async function markFneCertified(db: Database, queueId: number, saleId: number, result: FneCertificationResult): Promise<void> {
  await db
    .update(schema.sales)
    .set({
      fneStatus: "certified",
      fneReference: result.reference,
      fneNcc: result.ncc,
      fneQrToken: result.token,
      fneBalanceSticker: result.balanceSticker,
      fneError: null,
      fneCertifiedAt: new Date().toISOString(),
    })
    .where(eq(schema.sales.id, saleId))
    .run();
  await db.delete(schema.fneQueue).where(eq(schema.fneQueue.id, queueId)).run();
}

/** Tentative échouée : incrémente le compteur, garde la ligne en file pour une nouvelle tentative (jamais bloquant pour la vente elle-même). */
export async function markFneAttemptFailed(db: Database, queueId: number, saleId: number, error: string): Promise<void> {
  const row = await db.select().from(schema.fneQueue).where(eq(schema.fneQueue.id, queueId)).get();
  const attemptCount = (row?.attemptCount ?? 0) + 1;
  await db
    .update(schema.fneQueue)
    .set({ attemptCount, lastAttemptAt: new Date().toISOString(), lastError: error })
    .where(eq(schema.fneQueue.id, queueId))
    .run();
  await db.update(schema.sales).set({ fneStatus: "failed", fneError: error }).where(eq(schema.sales.id, saleId)).run();
}
