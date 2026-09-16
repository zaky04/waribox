import {
  applyCatalogSnapshot,
  applyRemoteSyncEvent,
  enqueueOutbox,
  getLastAppliedSeq,
  listPendingOutbox,
  markOutboxSent,
  onSyncEvent,
  setLastAppliedSeq,
  type CatalogSnapshot,
  type SyncEvent,
} from "@gestion-boutique/core";
import type { Database } from "@gestion-boutique/database";
import { withTransaction } from "@gestion-boutique/database";
import { MasterPairingPayload, WsMessage, WsMessageTypes } from "@gestion-boutique/network";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauriRuntime } from "../settings/tauriRuntime";
import { scanForMaster } from "./lanScan";

export type WorkerConnectionStatus = "idle" | "connecting" | "connected" | "error" | "disconnected";

const HANDSHAKE_TIMEOUT_MS = 5000;

type DiscoveryEvent =
  | { kind: "found"; masterId: string; host: string; port: number }
  | { kind: "lost"; masterId: string };

/**
 * Pilote la connexion sortante de ce Worker vers le Master (ouverture du
 * WebSocket, poignée de main hello/helloAck avec le jeton de pairage) et,
 * depuis la Phase 2 (voir CLAUDE.md), la réplication des ventes/mouvements
 * de stock/dépenses : envoi des événements créés localement (file d'attente
 * persistée si hors ligne), application des événements reçus du Master,
 * instantané initial du catalogue à la toute première connexion.
 *
 * Fonctionne identiquement sur PWA, Tauri desktop et Tauri Android : `WebSocket`
 * est une API standard, aucune dépendance native n'est nécessaire côté Worker
 * (contrairement au Master, qui doit écouter un socket — impossible depuis
 * une page web/WebView, d'où le serveur Rust côté Master).
 */
export function useWorkerConnection(db: Database, deviceId: string, deviceName: string) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WorkerConnectionStatus>("idle");
  const [masterName, setMasterName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPayload, setLastPayload] = useState<MasterPairingPayload | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // correlationId du message `sync` envoyé → id de la ligne __sync_outbox
  // correspondante, le temps d'en recevoir le `syncAck` (voir handleSyncAck).
  const pendingAcksRef = useRef<Map<string, number>>(new Map());
  const unsubscribeLocalSyncRef = useRef<(() => void) | null>(null);

  const clearHandshakeTimeout = () => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  // Envoie tout ce qui est resté en file (créé hors ligne, ou jamais confirmé
  // par un syncAck avant la dernière coupure) — appelé juste après un
  // helloAck accepté.
  const flushOutbox = useCallback(
    async (socket: WebSocket) => {
      const pending = await listPendingOutbox(db);
      for (const { id, event } of pending) {
        const message = new WsMessage({ type: WsMessageTypes.sync, payload: { event } });
        pendingAcksRef.current.set(message.correlationId, id);
        socket.send(message.encode());
      }
    },
    [db],
  );

  const connect = useCallback(
    (payload: MasterPairingPayload) => {
      socketRef.current?.close();
      clearHandshakeTimeout();

      setError(null);
      setMasterName(null);
      setLastPayload(payload);
      setStatus("connecting");

      let socket: WebSocket;
      try {
        socket = new WebSocket(`ws://${payload.host}:${payload.port}`);
      } catch {
        setStatus("error");
        setError(t("network.worker.errors.connectionFailed"));
        return;
      }
      socketRef.current = socket;

      timeoutRef.current = setTimeout(() => {
        setStatus("error");
        setError(t("network.worker.errors.timeout"));
        socket.close();
      }, HANDSHAKE_TIMEOUT_MS);

      socket.onopen = () => {
        void (async () => {
          const lastSyncSeq = await getLastAppliedSeq(db);
          socket.send(
            new WsMessage({
              type: WsMessageTypes.hello,
              payload: {
                deviceId,
                deviceName,
                role: "worker",
                protocolVersion: 1,
                token: payload.token,
                // `undefined` (jamais synchronisé) déclenche l'instantané
                // initial côté Master plutôt qu'un rattrapage — voir
                // CLAUDE.md, mode réseau Phase 2.
                ...(lastSyncSeq != null ? { lastSyncSeq } : {}),
              },
            }).encode(),
          );
        })();
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let message: WsMessage;
        try {
          message = WsMessage.decode(event.data);
        } catch {
          return;
        }

        if (message.type === WsMessageTypes.helloAck) {
          clearHandshakeTimeout();
          if (message.payload.accepted === true) {
            setMasterName(typeof message.payload.masterName === "string" ? message.payload.masterName : null);
            setStatus("connected");
            void flushOutbox(socket);
          } else {
            setStatus("error");
            setError(
              typeof message.payload.reason === "string"
                ? message.payload.reason
                : t("network.worker.errors.rejected"),
            );
            socket.close();
          }
        } else if (message.type === WsMessageTypes.ping) {
          socket.send(new WsMessage({ type: WsMessageTypes.pong, correlationId: message.correlationId }).encode());
        } else if (message.type === WsMessageTypes.error) {
          clearHandshakeTimeout();
          setStatus("error");
          setError(
            typeof message.payload.message === "string"
              ? message.payload.message
              : t("network.worker.errors.rejected"),
          );
        } else if (message.type === WsMessageTypes.sync) {
          void (async () => {
            const remoteEvent = message.payload.event as SyncEvent | undefined;
            const seq = message.payload.seq as number | undefined;
            if (!remoteEvent) return;
            await withTransaction(() => applyRemoteSyncEvent(db, remoteEvent));
            if (typeof seq === "number") await setLastAppliedSeq(db, seq);
          })();
        } else if (message.type === WsMessageTypes.syncAck) {
          const outboxId = pendingAcksRef.current.get(message.correlationId);
          if (outboxId != null) {
            pendingAcksRef.current.delete(message.correlationId);
            void markOutboxSent(db, outboxId);
          }
        } else if (message.type === WsMessageTypes.snapshotResponse) {
          void (async () => {
            const snapshot = message.payload.snapshot as CatalogSnapshot | undefined;
            const asOfSeq = message.payload.asOfSeq as number | undefined;
            if (!snapshot) return;
            await withTransaction(() => applyCatalogSnapshot(db, snapshot));
            await setLastAppliedSeq(db, asOfSeq ?? 0);
          })();
        }
      };

      socket.onclose = () => {
        clearHandshakeTimeout();
        socketRef.current = null;
        // Une connexion déjà établie qui tombe devient "disconnected"
        // (l'appareil garde le payload pour se reconnecter) ; une connexion
        // jamais aboutie (refusée, master injoignable) devient "error" —
        // sauf si le timeout ou le refus ci-dessus a déjà positionné "error".
        setStatus((current) => (current === "connecting" ? "error" : current === "connected" ? "disconnected" : current));
      };
    },
    [db, deviceId, deviceName, flushOutbox, t],
  );

  // Toute vente/mouvement/dépense créé localement (hors ligne ou non) part
  // d'abord dans la file d'attente persistée — envoyé tout de suite si déjà
  // connecté, sinon repris au prochain flushOutbox (voir connect ci-dessus).
  useEffect(() => {
    unsubscribeLocalSyncRef.current = onSyncEvent((event) => {
      void (async () => {
        const outboxId = await enqueueOutbox(db, event);
        const socket = socketRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          const message = new WsMessage({ type: WsMessageTypes.sync, payload: { event } });
          pendingAcksRef.current.set(message.correlationId, outboxId);
          socket.send(message.encode());
        }
      })();
    });
    return () => {
      unsubscribeLocalSyncRef.current?.();
    };
  }, [db]);

  const reconnect = useCallback(() => {
    if (lastPayload) connect(lastPayload);
  }, [connect, lastPayload]);

  const disconnect = useCallback(() => {
    clearHandshakeTimeout();
    socketRef.current?.close();
    socketRef.current = null;
    setStatus("idle");
    setMasterName(null);
    setLastPayload(null);
  }, []);

  /**
   * Retrouve automatiquement le Master déjà apparié (`lastPayload`) dont
   * l'adresse IP a changé — jamais utilisable pour un premier appairage
   * (pas de jeton à réutiliser sans avoir déjà scanné un QR une première
   * fois). Lance mDNS (Tauri uniquement) et le balayage réseau (toutes
   * plateformes) en parallèle ; le premier des deux qui trouve un candidat
   * validé (via le handshake hello/helloAck de `connect`, jamais la seule
   * présence détectée) gagne — voir CLAUDE.md, mode réseau Phase 1b.
   */
  const searchForMaster = useCallback(async () => {
    if (!lastPayload) return;
    setSearching(true);
    setSearchError(null);

    let settled = false;
    let unlistenDiscovery: UnlistenFn | null = null;

    const stopDiscovery = () => {
      unlistenDiscovery?.();
      unlistenDiscovery = null;
      if (isTauriRuntime()) void invoke("network_stop_discovery").catch(() => undefined);
    };

    const tryConnect = (host: string) => {
      if (settled) return;
      settled = true;
      stopDiscovery();
      connect(new MasterPairingPayload({ ...lastPayload, host }));
    };

    if (isTauriRuntime()) {
      try {
        unlistenDiscovery = await listen<DiscoveryEvent>("network:discovery-event", (event) => {
          if (event.payload.kind === "found" && event.payload.masterId === lastPayload.masterId) {
            tryConnect(event.payload.host);
          }
        });
        await invoke("network_start_discovery", { targetMasterId: lastPayload.masterId });
      } catch {
        // mDNS indisponible sur cet appareil/réseau — le balayage réseau
        // ci-dessous reste la voie de secours, universelle.
      }
    }

    const scanResult = await scanForMaster(lastPayload, deviceId, deviceName, () => settled);
    if (!settled) {
      if (scanResult) {
        tryConnect(scanResult);
      } else {
        settled = true;
        stopDiscovery();
        setSearchError(t("network.worker.errors.searchFailed"));
      }
    }
    setSearching(false);
  }, [connect, deviceId, deviceName, lastPayload, t]);

  return {
    status,
    masterName,
    error,
    lastPayload,
    searching,
    searchError,
    connect,
    reconnect,
    disconnect,
    searchForMaster,
  };
}
