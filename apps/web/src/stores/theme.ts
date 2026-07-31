import { create } from "zustand";

export type Theme = "dark" | "light";
const STORAGE_KEY = "waribox-theme";

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#f8fafc" : "#0f172a");
}

function getInitialTheme(): Theme {
  return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
}

interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
}

// Préférence d'affichage locale à l'appareil (pas une donnée métier) — stockée
// dans localStorage plutôt que dans business_settings, donc aucune migration
// de schéma nécessaire.
export const useThemeStore = create<ThemeState>((set, get) => {
  const initial = getInitialTheme();
  applyTheme(initial);
  return {
    theme: initial,
    toggleTheme: () => {
      const next: Theme = get().theme === "dark" ? "light" : "dark";
      localStorage.setItem(STORAGE_KEY, next);
      applyTheme(next);
      set({ theme: next });
    },
  };
});
