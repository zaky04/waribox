import { create } from "zustand";

export type Theme = "dark" | "light";
const STORAGE_KEY = "waribox-theme";

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#f4efe6" : "#16140f");
}

// Clair par défaut (papier) depuis la refonte "ticket de caisse" ; seul un
// choix explicite du mode nuit est mémorisé comme tel.
function getInitialTheme(): Theme {
  return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
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
