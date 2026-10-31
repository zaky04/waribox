import { createMasterProtocol, onSyncEvent, type ConnectedWorker } from "@gestion-boutique/core";
import type { Database } from "@gestion-boutique/database";
import { MasterPairingPayload, type WsMessage } from "@gestion-boutique/network";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type { ConnectedWorker };

type MasterEvent =
  | { kind: "connected"; connectionId: string }
  | { kind: "message"; connectionId: string; raw: string }
  | { kind: "disconnected"; connectionId: string };

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Le jeton de pairage est gardé d'un lancement à l'autre : les appareils déjà reliés
// peuvent se reconnecter après un redémarrage du Maître sans repasser par le QR.
const TOKEN_STORAGE_KEY = "waribox-master-token";
export const MASTER_RUNNING_KEY = "waribox-master-running";

function getMasterToken(): string {
  try {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored && /^[0-9a-f]{32}$/.test(stored)) return stored;
    const created = randomToken();
    localStorage.setItem(TOKEN_STORAGE_KEY, created);
    return created;
  } catch {
    return randomToken();
  }
}

async function sendToWorker(connectionId: string, message: WsMessage): Promise<void> {
  await invoke("network_send_to_worker", { connectionId, raw: message.encode() });
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
  // Tout le protocole (poignée de main, synchronisation, vérification de PIN,
  // décisions d'approbation) vit dans packages/core : ici on ne fait que le
  // brancher sur le serveur Rust et sur l'état React.
  const protocol = useMemo(
    () =>
      createMasterProtocol({
        db,
        masterId,
        masterName,
        send: sendToWorker,
        onWorkersChanged: setWorkers,
      }),
    [db, masterId, masterName],
  );
  const protocolRef = useRef(protocol);
  protocolRef.current = protocol;

  const handleEvent = useCallback((evt: MasterEvent) => {
    if (evt.kind === "disconnected") {
      protocolRef.current.handleDisconnect(evt.connectionId);
    } else if (evt.kind === "message") {
      void protocolRef.current.handleMessage(evt.connectionId, evt.raw);
    }
  }, []);

  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  const stop = useCallback(async () => {
    await invoke("network_stop_master").catch(() => undefined);
    unlistenRef.current?.();
    unlistenRef.current = null;
    unsubscribeSyncRef.current?.();
    unsubscribeSyncRef.current = null;
    try {
      localStorage.removeItem(MASTER_RUNNING_KEY);
    } catch {
      // ignoré
    }
    setRunning(false);
    setPairingPayload(null);
    protocolRef.current.reset();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      // Enregistré AVANT de démarrer le serveur Rust : celui-ci commence à accepter
      // des connexions dès le retour de `network_start_master`, et un événement Tauri
      // émis avant qu'un `listen()` existe côté JS est perdu (pas de rejeu). Un Worker
      // qui se connecterait dans cette fenêtre (ex. reconnexion automatique très
      // rapide après un redémarrage du Maître) verrait sinon son `hello` jamais
      // traité — silencieux jusqu'au délai d'attente du Worker.
      const unlisten = await listen<MasterEvent>("network:master-event", (event) => {
        handleEventRef.current(event.payload);
      });
      unlistenRef.current = unlisten;

      const token = getMasterToken();
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

      // Ce PC (Master) peut lui-même créer des ventes/mouvements/dépenses —
      // chaque événement local devient directement autorité (pas d'aller-
      // retour réseau nécessaire) et se diffuse à tous les Workers connectés.
      unsubscribeSyncRef.current = onSyncEvent((event) => {
        void protocolRef.current.broadcastLocalEvent(event);
      });

      setPairingPayload(new MasterPairingPayload({ masterId, masterName, host, port, token }));
      protocolRef.current.reset();
      setRunning(true);
      try {
        localStorage.setItem(MASTER_RUNNING_KEY, "1");
      } catch {
        // ignoré
      }
    } catch (err) {
      // Le listener a pu être enregistré avant qu'un `invoke` suivant n'échoue
      // (ex. port déjà utilisé) — pas de serveur fantôme dans ce cas.
      unlistenRef.current?.();
      unlistenRef.current = null;
      setError(err instanceof Error ? err.message : t("network.master.errors.startFailed"));
    } finally {
      setStarting(false);
    }
  }, [masterId, masterName, t]);

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
