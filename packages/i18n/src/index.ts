import i18next from "i18next";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

export type Language = "fr" | "en";
export const LANGUAGES: Language[] = ["fr", "en"];
export const DEFAULT_LANGUAGE: Language = "fr";

// Instance partagée entre apps/web (via react-i18next, voir I18nProvider) et
// les packages sans React (core, printer, reports) qui appellent `t()`
// directement — un seul changeLanguage() met à jour tout le monde puisque
// tout tourne dans le même runtime JS (navigateur/webview Tauri), pas besoin
// de propager une langue/fonction `t` à travers chaque signature de fonction.
i18next.init({
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  resources: {
    fr: { translation: fr },
    en: { translation: en },
  },
  interpolation: { escapeValue: false },
});

export function setLanguage(lang: Language): void {
  i18next.changeLanguage(lang);
}

export function getLanguage(): Language {
  return (i18next.language as Language) ?? DEFAULT_LANGUAGE;
}

export const t = i18next.t.bind(i18next);
export { i18next };
