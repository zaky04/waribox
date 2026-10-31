import type { Database } from "@gestion-boutique/database";
import { withTransaction } from "@gestion-boutique/database";
import { WsMessage, WsMessageTypes } from "@gestion-boutique/network";
import { issuePinChallenge, PIN_VERIFY_CONTEXT, pinChallengeKind, verifyPinProof } from "../auth/pinProof";
import { decideApprovalRequestRemote } from "../services/ApprovalRequestsService";
import { logAction } from "../services/AuditService";
import { createGrantStore } from "./approvalGrants";
import { applyRemoteSyncEvent } from "./applyRemoteEvents";
import { buildCatalogSnapshot } from "./snapshot";
import { appendToSyncLog, getMaxSyncSeq, listSyncLogSince } from "./syncStore";
import type { SyncEvent } from "./syncEvents";

// Cœur du protocole côté Maître, sans réseau ni interface : on lui donne une
// fonction d'envoi (`send`) et on lui passe chaque trame reçue ; la couche
// réseau de l'application (hook React + serveur Rust) ne fait que brancher les
// deux. C'est ce qui permet de tester le protocole de bout en bout dans les
// tests (voir masterProtocol.test.ts) au lieu de n'en tester que des morceaux.

export interface ConnectedWorker {
  connectionId: string;
  deviceId: string;
  deviceName: string;
}

export interface MasterProtocolDeps {
  db: Database;
  masterId: string;
  masterName: string;
  send: (connectionId: string, message: WsMessage) => Promise<void> | void;
  onWorkersChanged?: (workers: ConnectedWorker[]) => void;
}

const KNOWN_EVENT_TYPES = new Set([
  "sale.created",
  "stockEntry.created",
  "stockLoss.created",
  "stockTransfer.created",
  "stockBreakdown.created",
  "expense.created",
  "approvalRequest.created",
  "approvalRequest.decided",
]);

function isSyncEvent(value: unknown): value is SyncEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === "string" && KNOWN_EVENT_TYPES.has(v.type) && typeof v.payload === "object" && v.payload !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createMasterProtocol(deps: MasterProtocolDeps) {
  const { db, masterId, masterName } = deps;
  const workers = new Map<string, ConnectedWorker>();
  // Autorisations d'approbation délivrées après vérification d'un PIN (voir approvalGrants.ts).
  const grants = createGrantStore();

  // Tout ce qui écrit (événements reçus, décisions) passe dans une seule file :
  // l'ordre d'arrivée est l'ordre d'application ET l'ordre des numéros du journal.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>): Promise<void> => {
    const run = queue.then(job, job);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const notifyWorkers = () => deps.onWorkersChanged?.([...workers.values()]);
  const send = async (connectionId: string, message: WsMessage) => {
    try {
      await deps.send(connectionId, message);
    } catch {
      // connexion déjà partie : sans importance
    }
  };

  async function broadcast(event: SyncEvent, seq: number, exceptConnectionId: string | null) {
    const message = new WsMessage({ type: WsMessageTypes.sync, payload: { event, seq } });
    await Promise.all([...workers.keys()].filter((id) => id !== exceptConnectionId).map((id) => send(id, message)));
  }

  async function handleHello(connectionId: string, message: WsMessage) {
    const { deviceId, deviceName, lastSyncSeq } = message.payload;
    if (typeof deviceId !== "string" || typeof deviceName !== "string" || !deviceId || !deviceName) {
      await send(connectionId, message.errorReply("INVALID_HELLO", "deviceId/deviceName requis"));
      return;
    }
    workers.set(connectionId, { connectionId, deviceId, deviceName });
    notifyWorkers();
    await send(
      connectionId,
      new WsMessage({
        type: WsMessageTypes.helloAck,
        payload: { masterId, masterName, protocolVersion: 1, accepted: true },
        correlationId: message.correlationId,
      }),
    );
    // Jamais synchronisé : instantané complet ; déjà connu : rattrapage du manqué.
    if (typeof lastSyncSeq !== "number") {
      await sendSnapshot(connectionId);
    } else {
      for (const { seq, event } of await listSyncLogSince(db, lastSyncSeq)) {
        await send(connectionId, new WsMessage({ type: WsMessageTypes.sync, payload: { event, seq } }));
      }
    }
  }

  async function sendSnapshot(connectionId: string) {
    const snapshot = await buildCatalogSnapshot(db);
    const asOfSeq = await getMaxSyncSeq(db);
    await send(connectionId, new WsMessage({ type: WsMessageTypes.snapshotResponse, payload: { snapshot, asOfSeq } }));
  }

  // Événement reçu d'un appareil relié : validé et appliqué atomiquement, puis
  // consigné et rediffusé. Un refus est TOUJOURS signalé à l'émetteur
  // (`syncRejected`) — sans ça il le renvoyait indéfiniment sans jamais savoir
  // que la vente n'était pas arrivée.
  async function handleSync(connectionId: string, message: WsMessage) {
    const event = message.payload.event;
    const worker = workers.get(connectionId);
    try {
      if (!isSyncEvent(event)) throw new Error("événement de synchronisation invalide");
      // Le responsable n'est reconnu que si le Maître a lui-même vérifié son PIN pour cet appareil.
      const deviceId = worker?.deviceId ?? connectionId;
      const approverId = grants.check(event.grantId, event.approverId, deviceId) ? (event.approverId as number) : null;
      await withTransaction(() => applyRemoteSyncEvent(db, event, "worker", approverId));
      if (event.grantId) grants.consume(event.grantId);
      // L'autorisation ne sert qu'à la validation : on ne la consigne pas ni ne la rediffuse.
      const { grantId: _grantId, ...loggable } = event;
      const seq = await appendToSyncLog(db, loggable, deviceId);
      await send(connectionId, new WsMessage({ type: WsMessageTypes.syncAck, correlationId: message.correlationId }));
      await broadcast(loggable, seq, connectionId);
    } catch (err) {
      const reason = errorMessage(err);
      await send(
        connectionId,
        new WsMessage({
          type: WsMessageTypes.syncRejected,
          payload: { reason, eventType: isSyncEvent(event) ? event.type : null },
          correlationId: message.correlationId,
        }),
      );
      try {
        await logAction(db, {
          userId: null,
          action: "sync_event_rejected",
          entity: "sync",
          metadata: { deviceId: worker?.deviceId ?? null, deviceName: worker?.deviceName ?? null, eventType: isSyncEvent(event) ? event.type : null, reason },
        });
      } catch {
        // la trace d'audit ne doit jamais masquer le refus lui-même
      }
    }
  }

  async function handlePinChallenge(connectionId: string, message: WsMessage) {
    try {
      const approverId = Number(message.payload.approverId);
      if (!Number.isInteger(approverId)) throw new Error("responsable invalide");
      const kind = message.payload.kind === "approval" ? "approval" : "unlock";
      const challenge = await issuePinChallenge(db, approverId, Date.now(), kind);
      await send(connectionId, new WsMessage({ type: WsMessageTypes.pinChallengeResult, payload: { ok: true, challenge }, correlationId: message.correlationId }));
    } catch (err) {
      await send(connectionId, new WsMessage({ type: WsMessageTypes.pinChallengeResult, payload: { ok: false, error: errorMessage(err) }, correlationId: message.correlationId }));
    }
  }

  async function handlePinVerify(connectionId: string, message: WsMessage) {
    const { approverId, nonce, proof } = message.payload;
    try {
      if (!Number.isInteger(approverId) || typeof nonce !== "string" || typeof proof !== "string") throw new Error("demande invalide");
      const kind = pinChallengeKind(nonce);
      const ok = await verifyPinProof(db, approverId as number, nonce, PIN_VERIFY_CONTEXT, proof);
      // Un PIN d'approbation vérifié donne droit à une autorisation à usage unique pour cet appareil.
      const worker = workers.get(connectionId);
      const grantId = ok && kind === "approval" && worker ? grants.issue(approverId as number, worker.deviceId) : undefined;
      await send(connectionId, new WsMessage({ type: WsMessageTypes.pinVerifyResult, payload: { ok, ...(grantId ? { grantId } : {}) }, correlationId: message.correlationId }));
    } catch (err) {
      await send(connectionId, new WsMessage({ type: WsMessageTypes.pinVerifyResult, payload: { ok: false, error: errorMessage(err) }, correlationId: message.correlationId }));
    }
  }

  async function handleApprovalDecision(connectionId: string, message: WsMessage) {
    const { requestSyncId, approverId, approve, note, nonce, proof } = message.payload;
    try {
      if (typeof requestSyncId !== "string" || !Number.isInteger(approverId) || typeof approve !== "boolean" || typeof nonce !== "string" || typeof proof !== "string") {
        throw new Error("demande invalide");
      }
      await decideApprovalRequestRemote(db, {
        requestSyncId,
        approverId: approverId as number,
        approve,
        note: typeof note === "string" ? note : undefined,
        nonce,
        proof,
      });
      await send(connectionId, new WsMessage({ type: WsMessageTypes.approvalDecisionResult, payload: { ok: true }, correlationId: message.correlationId }));
    } catch (err) {
      await send(connectionId, new WsMessage({ type: WsMessageTypes.approvalDecisionResult, payload: { ok: false, error: errorMessage(err) }, correlationId: message.correlationId }));
    }
  }

  return {
    /** Traite une trame reçue d'une connexion DÉJÀ authentifiée par jeton (le serveur ferme les autres). Ne lève jamais. */
    handleMessage(connectionId: string, raw: string): Promise<void> {
      let message: WsMessage;
      try {
        message = WsMessage.decode(raw);
      } catch {
        return Promise.resolve();
      }
      switch (message.type) {
        case WsMessageTypes.hello:
          return enqueue(() => handleHello(connectionId, message));
        case WsMessageTypes.ping:
          return Promise.resolve(send(connectionId, new WsMessage({ type: WsMessageTypes.pong, correlationId: message.correlationId })));
      }
      // Tout le reste exige une poignée de main (hello) réussie sur cette connexion.
      if (!workers.has(connectionId)) return Promise.resolve();
      switch (message.type) {
        case WsMessageTypes.sync:
          return enqueue(() => handleSync(connectionId, message));
        case WsMessageTypes.snapshotRequest:
          return enqueue(() => sendSnapshot(connectionId));
        case WsMessageTypes.pinChallenge:
          return enqueue(() => handlePinChallenge(connectionId, message));
        case WsMessageTypes.pinVerify:
          return enqueue(() => handlePinVerify(connectionId, message));
        case WsMessageTypes.approvalDecision:
          return enqueue(() => handleApprovalDecision(connectionId, message));
        default:
          return Promise.resolve();
      }
    },

    handleDisconnect(connectionId: string): void {
      if (workers.delete(connectionId)) notifyWorkers();
    },

    reset(): void {
      workers.clear();
      notifyWorkers();
    },

    /** Événement créé par CE PC (le Maître fait autorité) : consigné et diffusé à tous les appareils reliés. */
    broadcastLocalEvent(event: SyncEvent): Promise<void> {
      return enqueue(async () => {
        const seq = await appendToSyncLog(db, event, masterId);
        await broadcast(event, seq, null);
      });
    },

    getWorkers: (): ConnectedWorker[] => [...workers.values()],

    /** Résolu quand tout ce qui était en cours est terminé (tests). */
    idle: (): Promise<void> => queue,
  };
}

export type MasterProtocol = ReturnType<typeof createMasterProtocol>;
