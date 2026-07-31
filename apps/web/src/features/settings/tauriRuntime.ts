import { isTauri } from "@tauri-apps/api/core";

// La section "Mettre à jour" n'a de sens que dans le build desktop (Tauri) —
// la PWA/navigateur a déjà son propre mécanisme de mise à jour (service
// worker, UpdateBanner), sans rapport avec l'installation d'un nouveau
// binaire.
export function isTauriRuntime(): boolean {
  return isTauri();
}
