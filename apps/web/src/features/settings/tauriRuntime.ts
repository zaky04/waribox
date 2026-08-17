import { isTauri } from "@tauri-apps/api/core";

// La section "Mettre à jour" n'a de sens que dans le build desktop (Tauri) —
// la PWA/navigateur a déjà son propre mécanisme de mise à jour (service
// worker, UpdateBanner), sans rapport avec l'installation d'un nouveau
// binaire.
export function isTauriRuntime(): boolean {
  return isTauri();
}

// isTauri() ne distingue pas desktop d'Android (les deux sont des runtimes
// Tauri) — or le flux "Installer une mise à jour" de Paramètres (sélection
// d'un .exe/.msi puis openPath) n'a de sens que sur desktop ; sur Android il
// s'affichait sans rien pouvoir faire d'utile (pas de .exe/.msi, openPath ne
// sait pas "installer" un .apk de cette façon). Pas de
// @tauri-apps/plugin-os installé dans ce projet, donc détection par
// user-agent : le WebView Android de Tauri est un vrai WebView Android,
// userAgent contient "Android" (jamais le cas sur Windows/macOS/Linux).
export function isDesktopTauriRuntime(): boolean {
  return isTauri() && !/Android/i.test(navigator.userAgent);
}
