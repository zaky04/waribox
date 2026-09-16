import {
  appendToSyncLog,
  applyRemoteSyncEvent,
  buildCatalogSnapshot,
  getMaxSyncSeq,
  listSyncLogSince,
  onSyncEvent,
  type SyncEvent,
} from "@gestion-boutique/core";
import type { Database } from "@gestion-boutique/database";
import { withTransaction } from "@gestion-boutique/database";
import { MasterPairingPayload, WsMessage, WsMessageTypes } from "@gestion-boutique/network";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface ConnectedWorker {
  connectionId: string;
  deviceId: string;
  deviceName: string;
}

type MasterEvent =
  | { kind: "connected"; connectionId: string }
  | { kind: "message"; connectionId: string; raw: string }
  | { kind: "disconnected"; connectionId: string };

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendToWorker(connectionId: string, message: WsMessage): Promise<void> {
  await invoke("network_send_to_worker", { connectionId, raw: message.encode() });
}

async function broadcastExcept(connectionIds: string[], exceptConnectionId: string | null, message: WsMessage): Promise<void> {
  const raw = message.encode();
  await Promise.all(
    connectionIds
      .filter((id) => id !== exceptConnectionId)
      .map((id) => invoke("network_send_to_worker", { connectionId: id, raw }).catch(() => undefined)),
  );
}

/**
 * Pilote le serveur Master : démarrage/arrêt du serveur Rust, poignée de main
 * avec chaque Worker, et depuis la Phase 2 (voir CLAUDE.md) la réplication
 * des ventes/mouvements de stock/dépenses — le Master fait autorité sur
 * `__sync_log` (assigne le `seq` de chaque événement accepté, qu'il vienne
 * d'un Worker ou de ce PC lui-même) et répond à la demande d'instantané
 * initial du catalogue d'un Worker jamais synchronisé.
 */
export function useMasterServer(db: Database, masterId: string, masterName: string) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pairingPayload, setPairingPayload] = useState<MasterPairingPayload | null>(null);
  const [workers, setWorkers] = useState<ConnectedWorker[]>([]);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const unsubscribeSyncRef = useRef<(() => void) | null>(null);
  const workersRef = useRef<ConnectedWorker[]>([]);
  workersRef.current = workers;

  // Diffuse un événement (créé par CE PC en tant que Master, ou déjà reçu et
  // accepté d'un Worker) à tous les Workers connectés autres que `origin`.
  const broadcastEvent = useCallback(
    async (event: SyncEvent, seq: number, exceptConnectionId: string | null) => {
      await broadcastExcept(
        workersRef.current.map((w) => w.connectionId),
        exceptConnectionId,
        new WsMessage({ type: WsMessageTypes.sync, payload: { event, seq } }),
      );
    },
    [],
  );

  const handleHello = useCallback(
    async (connectionId: string, message: WsMessage) => {
      const { deviceId, deviceName, lastSyncSeq } = message.payload;
      if (typeof deviceId !== "string" || typeof deviceName !== "string" || !deviceId || !deviceName) {
        void sendToWorker(connectionId, message.errorReply("INVALID_HELLO", "deviceId/deviceName requis"));
        return;
      }
      setWorkers((prev) => [...prev.filter((w) => w.connectionId !== connectionId), { connectionId, deviceId, deviceName }]);
      await sendToWorker(
        connectionId,
        new WsMessage({
          type: WsMessageTypes.helloAck,
          payload: { masterId, masterName, protocolVersion: 1, accepted: true },
          correlationId: message.correlationId,
        }),
      );

      // Voir CLAUDE.md, mode réseau Phase 2 : un Worker jamais synchronisé
      // (aucun `lastSyncSeq` connu) reçoit l'instantané complet du
      // catalogue ; un Worker déjà connu reçoit le rattrapage de ce qu'il a
      // manqué depuis sa dernière connexion.
      if (typeof lastSyncSeq !== "number") {
        const snapshot = await buildCatalogSnapshot(db);
        const asOfSeq = await getMaxSyncSeq(db);
        await sendToWorker(
          connectionId,
          new WsMessage({ type: WsMessageTypes.snapshotResponse, payload: { snapshot, asOfSeq } }),
        );
      } else {
        const backlog = await listSyncLogSince(db, lastSyncSeq);
        for (const { seq, event } of backlog) {
          await sendToWorker(connectionId, new WsMessage({ type: WsMessageTypes.sync, payload: { event, seq } }));
        }
      }
    },
    [db, masterId, masterName],
  );

  const handleSync = useCallback(
    async (connectionId: string, message: WsMessage) => {
      const event = message.payload.event as SyncEvent | undefined;
      if (!event) return;
      await withTransaction(() => applyRemoteSyncEvent(db, event));
      const originDeviceId = workersRef.current.find((w) => w.connectionId === connectionId)?.deviceId ?? connectionId;
      const seq = await appendToSyncLog(db, event, originDeviceId);
      await sendToWorker(connectionId, new WsMessage({ type: WsMessageTypes.syncAck, correlationId: message.correlationId }));
      await broadcastEvent(event, seq, connectionId);
    },
    [broadcastEvent, db],
  );

  const handleSnapshotRequest = useCallback(
    async (connectionId: string) => {
      const snapshot = await buildCatalogSnapshot(db);
      const asOfSeq = await getMaxSyncSeq(db);
      await sendToWorker(
        connectionId,
        new WsMessage({ type: WsMessageTypes.snapshotResponse, payload: { snapshot, asOfSeq } }),
      );
    },
    [db],
  );

  const handleEvent = useCallback(
    (evt: MasterEvent) => {
      if (evt.kind === "disconnected") {
        setWorkers((prev) => prev.filter((w) => w.connectionId !== evt.connectionId));
        return;
      }
      if (evt.kind !== "message") return;

      let message: WsMessage;
      try {
        message = WsMessage.decode(evt.raw);
      } catch {
        return;
      }

      if (message.type === WsMessageTypes.hello) {
        void handleHello(evt.connectionId, message);
      } else if (message.type === WsMessageTypes.ping) {
        void sendToWorker(evt.connectionId, new WsMessage({ type: WsMessageTypes.pong, correlationId: message.correlationId }));
      } else if (message.type === WsMessageTypes.sync) {
        void handleSync(evt.connectionId, message);
      } else if (message.type === WsMessageTypes.snapshotRequest) {
        void handleSnapshotRequest(evt.connectionId);
      }
    },
    [handleHello, handleSnapshotRequest, handleSync],
  );

  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  const stop = useCallback(async () => {
    await invoke("network_stop_master").catch(() => undefined);
    unlistenRef.current?.();
    unlistenRef.current = null;
    unsubscribeSyncRef.current?.();
    unsubscribeSyncRef.current = null;
    setRunning(false);
    setPairingPayload(null);
    setWorkers([]);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      const token = randomToken();
      // Port fixe (pas 0/OS) : nécessaire pour que le balayage réseau côté
      // Worker (lanScan.ts) sache sur quel port sonder chaque adresse — voir
      // CLAUDE.md, mode réseau Phase 1b. Source de vérité côté Rust.
      const defaultPort = await invoke<number>("network_default_port");
      const port = await invoke<number>("network_start_master", {
        port: defaultPort,
        token,
        masterId,
        masterName,
      });
      const host = await invoke<string>("network_local_ip");

      const unlisten = await listen<MasterEvent>("network:master-event", (event) => {
        handleEventRef.current(event.payload);
      });
      unlistenRef.current = unlisten;

      // Ce PC (Master) peut lui-même créer des ventes/mouvements/dépenses —
      // chaque événement local devient directement autorité (pas d'aller-
      // retour réseau nécessaire) et se diffuse à tous les Workers connectés.
      unsubscribeSyncRef.current = onSyncEvent((event) => {
        void (async () => {
          const seq = await appendToSyncLog(db, event, masterId);
          await broadcastEvent(event, seq, null);
        })();
      });

      setPairingPayload(new MasterPairingPayload({ masterId, masterName, host, port, token }));
      setWorkers([]);
      setRunning(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("network.master.errors.startFailed"));
    } finally {
      setStarting(false);
    }
  }, [broadcastEvent, db, masterId, masterName, t]);

  // Arrête le serveur Rust si le composant qui pilote cet écran est démonté
  // pendant qu'il tourne (navigation ailleurs) — évite un serveur fantôme
  // qui continue d'écouter sans plus aucun écran pour en montrer l'état.
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unsubscribeSyncRef.current?.();
    };
  }, []);

  return { running, starting, pairingPayload, workers, error, start, stop };
}
