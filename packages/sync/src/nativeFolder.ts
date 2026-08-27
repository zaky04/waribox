// Écriture de fichier native via Tauri (plugin-fs) sur Android, où ni l'API
// web File System Access (voir folderHandle.ts) ni le repli "téléchargement"
// (blob URL + <a download>, WebView Android sans gestionnaire de
// téléchargement intégré) ne fonctionnent.
//
// Historique : une première version de ce fichier laissait choisir un
// dossier via plugin-dialog (`open({ directory: true })`), sur le modèle du
// sélecteur de dossier desktop. Testé en conditions réelles sur un vrai
// appareil Android, cet appel rejette immédiatement avec
// "Folder picker is not implemented on mobile" — une limitation du plugin
// Tauri lui-même sur mobile, pas un problème de configuration côté app.
// Plutôt que de dépendre d'un sélecteur interactif dont on ne peut pas
// garantir le support mobile, on écrit directement dans le dossier
// Téléchargements standard de l'appareil (accès prévu et documenté de
// plugin-fs, sans boîte de dialogue) — exactement le comportement déjà
// accepté comme suffisant pour ce projet (voir journal CLAUDE.md).
//
// Volontairement limité à Android : le flux existant (showDirectoryPicker
// côté web) fonctionne déjà correctement sur desktop (WebView2/Edge), donc
// pas de raison d'en changer là où rien n'est cassé.

import { isTauri } from "@tauri-apps/api/core";

// Même détection que isDesktopTauriRuntime() dans apps/web (pas de
// @tauri-apps/plugin-os installé dans ce projet) — inversée : ici on veut
// spécifiquement "dans Tauri, sur Android", pas "dans Tauri, hors Android".
// isTauri() est synchrone (drapeau posé par le runtime Tauri au chargement
// de la page) — pas besoin d'import dynamique ni d'attendre quoi que ce soit.
export function isAndroidTauriRuntime(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent) && isTauri();
}

// Écrit dans le dossier Téléchargements public de l'appareil — pas de
// sélection de dossier, pas de boîte de dialogue, donc rien qui dépende
// d'une fonctionnalité de plugin-dialog dont le support mobile n'est pas
// garanti. `BaseDirectory.Download` est un chemin résolu par plugin-fs
// lui-même (portée déclarée dans capabilities/default.json), pas une valeur
// qu'on construit à la main.
export async function writeToAndroidDownloads(filename: string, bytes: Uint8Array): Promise<void> {
  const { writeFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  await writeFile(filename, bytes, { baseDir: BaseDirectory.Download });
}
