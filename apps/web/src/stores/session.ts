import type { AuthenticatedUser } from "@gestion-boutique/core";
import { create } from "zustand";

interface SessionState {
  user: AuthenticatedUser | null;
  isLocked: boolean;
  setUser: (user: AuthenticatedUser) => void;
  lock: () => void;
  unlock: () => void;
  logout: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  user: null,
  isLocked: false,
  setUser: (user) => set({ user, isLocked: false }),
  lock: () => set({ isLocked: true }),
  unlock: () => set({ isLocked: false }),
  logout: () => set({ user: null, isLocked: false }),
}));
