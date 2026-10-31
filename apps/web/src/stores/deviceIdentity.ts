import { create } from "zustand";

const ID_STORAGE_KEY = "waribox-device-id";
const NAME_STORAGE_KEY = "waribox-device-name";

function getInitialDeviceId(): string {
  const stored = localStorage.getItem(ID_STORAGE_KEY);
  if (stored) return stored;
  const generated = crypto.randomUUID();
  localStorage.setItem(ID_STORAGE_KEY, generated);
  return generated;
}

function getInitialDeviceName(): string {
  return localStorage.getItem(NAME_STORAGE_KEY) ?? "";
}

interface DeviceIdentityState {
  deviceId: string;
  deviceName: string;
  setDeviceName: (name: string) => void;
}

// Identité locale de cet appareil pour le mode réseau (Master/Worker) — pas
// une donnée métier (jamais en SQLite), stockée en localStorage comme
// language.ts/theme.ts. `deviceId` est généré une seule fois et persiste
// entre redémarrages (contrairement au premier jet de ce mécanisme côté
// Fougag, qui régénérait un id à chaque montage d'écran — voir son propre
// README_DEV.md, corrigé plus tard dans son historique).
export const useDeviceIdentityStore = create<DeviceIdentityState>((set) => ({
  deviceId: getInitialDeviceId(),
  deviceName: getInitialDeviceName(),
  setDeviceName: (name: string) => {
    localStorage.setItem(NAME_STORAGE_KEY, name);
    set({ deviceName: name });
  },
}));
