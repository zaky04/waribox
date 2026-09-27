import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { useDeviceIdentityStore } from "../../stores/deviceIdentity";
import { useDeviceRoleStore } from "../../stores/deviceRole";
import { isDesktopTauriRuntime } from "../settings/tauriRuntime";
import { MASTER_RUNNING_KEY, useMasterServer } from "./useMasterServer";
import { useWorkerConnection } from "./useWorkerConnection";

interface NetworkContextValue {
  master: ReturnType<typeof useMasterServer>;
  worker: ReturnType<typeof useWorkerConnection>;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

// Le moteur réseau (serveur du Maître, connexion de l'Appareil relié, mise en file
// et diffusion des événements) vit ici, une seule fois pour toute l'application :
// s'il était rattaché à l'écran Paramètres, il s'arrêterait dès qu'on change d'onglet
// et plus aucune vente ne serait diffusée. L'écran Paramètres ne fait que le piloter.
export function NetworkProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const db = useDatabase();
  const { deviceId, deviceName } = useDeviceIdentityStore();
  const role = useDeviceRoleStore((s) => s.role);

  const master = useMasterServer(db, deviceId, deviceName.trim() || t("network.defaultMasterName"));
  const worker = useWorkerConnection(db, deviceId, deviceName.trim() || t("network.defaultWorkerName"), role === "worker");

  // Maître qui tournait avant la fermeture de l'application : redémarre tout seul.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current || role !== "master" || !isDesktopTauriRuntime()) return;
    let wasRunning = false;
    try {
      wasRunning = localStorage.getItem(MASTER_RUNNING_KEY) === "1";
    } catch {
      wasRunning = false;
    }
    if (!wasRunning) return;
    autoStartedRef.current = true;
    void master.start();
  }, [role, master]);

  return <NetworkContext.Provider value={{ master, worker }}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue {
  const value = useContext(NetworkContext);
  if (!value) throw new Error("useNetwork doit être utilisé sous <NetworkProvider>");
  return value;
}
