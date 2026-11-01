import type { Database } from "@gestion-boutique/database";
import { withTransaction } from "@gestion-boutique/database";
import { WsMessage, WsMessageTypes } from "@gestion-boutique/network";
import { applyRemoteSyncEvent } from "./applyRemoteEvents";
import { applyCatalogSnapshot, rebaseStock, resetBusinessData, type CatalogSnapshot, type StockBalance } from "./snapshot";
import { clearOutbox, getCatalogHashes, getLastAppliedSeq, getPairedMasterId, listPendingOutbox, setCatalogHashes, setLastAppliedSeq, setPairedMasterId } from "./syncStore";
import type { SyncEvent } from "./syncEvents";

// Côté appareil relié : réception de ce que le Maître envoie (événements, état du catalogue et du stock).
// Sans réseau ni interface — la couche réseau fournit `send` et passe chaque trame à `handleMessage`.
//
// Règles qui rendent la réplication sûre :
//  1. Tout est traité EN FILE, dans l'ordre d'arrivée (événements, accusés, états).
//  2. Un événement qui échoue n'est jamais « sauté » en silence : on garde sa place, on redemande le
//     catalogue au Maître (la cause la plus fréquente est un produit ou un client créé depuis) puis on
//     le rejoue. Le repère de progression (`lastAppliedSeq`) n'avance pas tant qu'un événement attend.
//  3. L'alignement du stock sur celui du Maître n'a lieu que si l'appareil est « au calme » : rien en
//     attente d'envoi, aucun événement local créé depuis la demande, tous les événements du Maître
//     appliqués. Sinon l'état reçu est déjà périmé et on le jette (une nouvelle demande suivra).

export interface WorkerSyncDeps {
  db: Database;
  /** Envoie une trame ; renvoie faux si la connexion n'est pas ouverte. */
  send: (message: WsMessage) => boolean;
  /** Dernière erreur d'application d'un événement du Maître (null = plus d'erreur). */
  onApplyError?: (reason: string | null) => void;
  now?: () => number;
}

/** Délai maximal entre deux alignements demandés au Maître quand rien ne le déclenche. */
export const REFRESH_INTERVAL_MS = 5 * 60_000;

interface FailedEvent {
  event: SyncEvent;
  seq: number | undefined;
}

export function createWorkerSync(deps: WorkerSyncDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => Date.now());

  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  let localEvents = 0; // événements créés sur CET appareil (incrémenté de façon synchrone à leur émission)
  let requestMark: number | null = null; // valeur de localEvents quand la dernière demande est partie
  const failed: FailedEvent[] = [];
  let highestSeq: number | null = null;
  let refreshWanted = false;
  let lastRequestAt = 0;

  const errorOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

  async function advanceTo(seq: number) {
    highestSeq = highestSeq === null ? seq : Math.max(highestSeq, seq);
    // Repère de progression : jamais au-delà d'un événement qui attend encore d'être rejoué.
    if (failed.length === 0) {
      const current = await getLastAppliedSeq(db);
      if (current === null || highestSeq > current) await setLastAppliedSeq(db, highestSeq);
    }
  }

  async function retryFailed() {
    const pending = failed.splice(0, failed.length);
    let lastError: string | null = null;
    for (const item of pending) {
      try {
        await withTransaction(() => applyRemoteSyncEvent(db, item.event));
      } catch (err) {
        // Toujours impossible après un catalogue à jour : on l'abandonne (visible), sinon il bloquerait tout pour toujours.
        lastError = errorOf(err);
      }
      if (item.seq !== undefined) highestSeq = highestSeq === null ? item.seq : Math.max(highestSeq, item.seq);
    }
    if (highestSeq !== null) await advanceTo(highestSeq);
    deps.onApplyError?.(lastError);
  }

  async function sendRequest(): Promise<boolean> {
    // Pas encore d'état de départ (premier appairage en cours) : le Maître envoie l'instantané complet de lui-même.
    if ((await getLastAppliedSeq(db)) === null) return false;
    if ((await listPendingOutbox(db)).length > 0) return false; // d'abord vider ce qui part vers le Maître
    requestMark = localEvents;
    const sent = deps.send(new WsMessage({ type: WsMessageTypes.snapshotRequest, payload: { knownHashes: await getCatalogHashes(db) } }));
    if (sent) {
      lastRequestAt = now();
      refreshWanted = false;
    }
    return sent;
  }

  async function onSyncMessage(message: WsMessage) {
    const event = message.payload.event as SyncEvent | undefined;
    const seq = typeof message.payload.seq === "number" ? message.payload.seq : undefined;
    if (!event) return;
    try {
      await withTransaction(() => applyRemoteSyncEvent(db, event));
      deps.onApplyError?.(null);
      if (seq !== undefined) await advanceTo(seq);
    } catch (err) {
      failed.push({ event, seq });
      deps.onApplyError?.(errorOf(err));
      refreshWanted = true;
      await sendRequest();
    }
  }

  async function onSnapshotMessage(message: WsMessage) {
    const snapshot = message.payload.snapshot as CatalogSnapshot | undefined;
    const asOfSeq = typeof message.payload.asOfSeq === "number" ? message.payload.asOfSeq : 0;
    if (!snapshot) return;

    if (message.payload.mode === "full") {
      // Premier appairage, changement de Maître, ou Maître revenu en arrière (restauré) : on repart de l'état du
      // Maître. Les données locales sont effacées (identifiants incompatibles). Les événements encore à envoyer
      // sont gardés si c'est le MÊME Maître (ils lui seront acceptés), sinon abandonnés.
      const masterId = typeof message.payload.masterId === "string" ? message.payload.masterId : null;
      await withTransaction(async () => {
        const paired = await getPairedMasterId(db);
        const sameMaster = masterId !== null && (paired === masterId || (paired === null && (await getLastAppliedSeq(db)) !== null));
        if (!sameMaster) await clearOutbox(db);
        await resetBusinessData(db);
        await applyCatalogSnapshot(db, snapshot);
        await setLastAppliedSeq(db, asOfSeq);
        if (masterId !== null) await setPairedMasterId(db, masterId);
      });
      failed.length = 0;
      highestSeq = asOfSeq;
      refreshWanted = false;
      deps.onApplyError?.(null);
      return;
    }

    // Rafraîchissement : le catalogue d'abord (sans le stock), même si l'appareil n'est pas au calme —
    // c'est ce qui débloque un événement en attente.
    const stock: StockBalance[] | undefined = snapshot.stockBalances;
    await withTransaction(() => applyCatalogSnapshot(db, { ...snapshot, stockBalances: undefined }));
    if (failed.length > 0) await retryFailed();

    // Le stock ensuite, seulement si l'état reçu est encore exact.
    if (!stock || failed.length > 0) return;
    const quiet = requestMark === localEvents && (await listPendingOutbox(db)).length === 0;
    const last = await getLastAppliedSeq(db);
    if (!quiet || last === null || last < asOfSeq) {
      refreshWanted = true; // état périmé : on en redemandera un
      return;
    }
    await withTransaction(async () => {
      await rebaseStock(db, stock);
      await setCatalogHashes(db, { ...(await getCatalogHashes(db)), ...snapshot.hashes });
    });
  }

  const api = {
    /** À appeler à chaque événement créé localement (synchrone) : invalide l'état en cours de demande. */
    noteLocalEvent(): void {
      localEvents++;
    },

    /** Le Maître a numéroté notre événement (`syncAck`) : ce numéro fait partie de notre historique. */
    noteAck(seq: unknown): Promise<void> {
      if (typeof seq !== "number") return Promise.resolve();
      return enqueue(() => advanceTo(seq));
    },

    /** Renvoie vrai si la trame était pour lui. */
    handleMessage(message: WsMessage): boolean {
      switch (message.type) {
        case WsMessageTypes.sync:
          void enqueue(() => onSyncMessage(message)).catch(() => undefined);
          return true;
        case WsMessageTypes.snapshotResponse:
          void enqueue(() => onSnapshotMessage(message)).catch((err) => deps.onApplyError?.(errorOf(err)));
          return true;
        case WsMessageTypes.catalogChanged:
          refreshWanted = true;
          void api.tick();
          return true;
        default:
          return false;
      }
    },

    /** Demande l'état au Maître (faux si l'appareil n'est pas prêt : envois en attente, hors connexion). */
    requestRefresh(): Promise<boolean> {
      return enqueue(sendRequest);
    },

    /** À appeler régulièrement tant que la connexion est ouverte (ex. toutes les 15 s). */
    async tick(): Promise<void> {
      const due = refreshWanted || failed.length > 0 || now() - lastRequestAt >= REFRESH_INTERVAL_MS;
      if (due) await api.requestRefresh();
    },

    hasFailedEvents: () => failed.length > 0,
    /** Résolu quand tout ce qui était en cours est terminé (tests). */
    idle: (): Promise<unknown> => queue,
  };
  return api;
}

export type WorkerSync = ReturnType<typeof createWorkerSync>;
