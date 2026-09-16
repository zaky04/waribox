import { create } from "zustand";

const STORAGE_KEY = "waribox-device-role";

export type DeviceRole = "master" | "worker" | null;

function getInitialRole(): DeviceRole {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "master" || stored === "worker" ? stored : null;
}

interface DeviceRoleState {
  role: DeviceRole;
  setRole: (role: DeviceRole) => void;
}

// Rôle réseau de cet appareil (Master/Worker/aucun = Solo) — pas une donnée
// métier, stockée en localStorage comme language.ts/theme.ts/deviceIdentity.ts :
// c'est un réglage propre à CET appareil, jamais répliqué. `null` est l'état
// par défaut de toute installation existante (Solo), donc aucune migration
// n'est nécessaire pour les utilisateurs déjà en place.
export const useDeviceRoleStore = create<DeviceRoleState>((set) => ({
  role: getInitialRole(),
  setRole: (role: DeviceRole) => {
    if (role === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, role);
    set({ role });
  },
}));
