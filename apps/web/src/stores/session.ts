import type { AuthenticatedUser } from "@gestion-boutique/core";
import { create } from "zustand";

interface SessionState {
  user: AuthenticatedUser | null;
  isLocked: boolean;
  // Non-null uniquement pendant une impersonation Admin — conserve le compte
  // d'origine pour permettre d'y revenir sans ressaisir d'identifiants.
  impersonatorUser: AuthenticatedUser | null;
  // Boutique sur laquelle l'utilisateur opère actuellement — n'a d'effet
  // visible que si le multi-boutique est activé (voir StoreSwitcher) ; sinon
  // toujours la boutique par défaut unique. Réinitialisé à chaque connexion,
  // pas persisté (comme le reste de la session).
  currentStoreId: number | null;
  setUser: (user: AuthenticatedUser) => void;
  lock: () => void;
  unlock: () => void;
  logout: () => void;
  impersonate: (target: AuthenticatedUser) => void;
  returnToSelf: () => void;
  setCurrentStore: (storeId: number) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  user: null,
  isLocked: false,
  impersonatorUser: null,
  currentStoreId: null,
  setUser: (user) => set({ user, isLocked: false }),
  lock: () => set({ isLocked: true }),
  unlock: () => set({ isLocked: false }),
  logout: () => set({ user: null, isLocked: false, impersonatorUser: null, currentStoreId: null }),
  setCurrentStore: (storeId) => set({ currentStoreId: storeId }),
  impersonate: (target) => {
    const current = get().user;
    // Garde le tout premier compte de la chaîne (jamais un compte déjà
    // impersonné) au cas où cette action serait un jour déclenchée deux fois
    // de suite sans repasser par returnToSelf.
    set({ user: target, impersonatorUser: get().impersonatorUser ?? current });
  },
  returnToSelf: () => {
    const original = get().impersonatorUser;
    if (!original) return;
    set({ user: original, impersonatorUser: null });
  },
}));
