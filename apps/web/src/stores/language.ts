import { DEFAULT_LANGUAGE, LANGUAGES, setLanguage, type Language } from "@gestion-boutique/i18n";
import { create } from "zustand";

const STORAGE_KEY = "waribox-language";

function getInitialLanguage(): Language {
  const stored = localStorage.getItem(STORAGE_KEY);
  return LANGUAGES.includes(stored as Language) ? (stored as Language) : DEFAULT_LANGUAGE;
}

interface LanguageState {
  language: Language;
  setLanguage: (lang: Language) => void;
}

// Préférence d'affichage locale à l'appareil (pas une donnée métier) — même
// convention que stores/theme.ts : localStorage plutôt que business_settings,
// donc aucune migration de schéma nécessaire.
export const useLanguageStore = create<LanguageState>((set) => {
  const initial = getInitialLanguage();
  setLanguage(initial);
  return {
    language: initial,
    setLanguage: (lang: Language) => {
      localStorage.setItem(STORAGE_KEY, lang);
      setLanguage(lang);
      set({ language: lang });
    },
  };
});
