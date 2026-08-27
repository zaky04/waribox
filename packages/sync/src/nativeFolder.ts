// Choix de dossier natif via Tauri (plugin-dialog + plugin-fs), pour les
// plateformes où l'API web File System Access est soit absente, soit
// présente sans implémentation native derrière (voir folderHandle.ts pour
// le cas Android/showDirectoryPicker) — et où même le repli "téléchargement"
// (blob URL + <a download>) ne fonctionne pas non plus : le WebView Android
// brut n'a aucun gestionnaire de téléchargement intégré (contrairement à un
// vrai navigateur Chrome), donc un clic sur un lien <a download> n'y produit
// simplement aucun effet sans câblage natif dédié, absent de ce projet.
//
// Volontairement limité à Android pour l'instant : le flux existant
// (showDirectoryPicker côté web) fonctionne déjà correctement sur desktop
// (WebView2/Edge), donc pas de raison d'en changer là où rien n'est cassé.

import { isTauri } from "@tauri-apps/api/core";

const STORAGE_PREFIX = "waribox-native-folder:";

export type NativeFolderKind = "backup" | "documents";

// Même détection que isDesktopTauriRuntime() dans apps/web (pas de
// @tauri-apps/plugin-os installé dans ce projet) — inversée : ici on veut
// spécifiquement "dans Tauri, sur Android", pas "dans Tauri, hors Android".
// isTauri() est synchrone (drapeau posé par le runtime Tauri au chargement
// de la page) — pas besoin d'import dynamique ni d'attendre quoi que ce soit.
export function isAndroidTauriRuntime(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent) && isTauri();
}

export function loadNativeFolderPath(kind: NativeFolderKind): string | null {
  return localStorage.getItem(STORAGE_PREFIX + kind);
}

function saveNativeFolderPath(kind: NativeFolderKind, path: string): void {
  localStorage.setItem(STORAGE_PREFIX + kind, path);
}

export function clearNativeFolderPath(kind: NativeFolderKind): void {
  localStorage.removeItem(STORAGE_PREFIX + kind);
}

// Ouvre le sélecteur de dossier natif d'Android (Storage Access Framework,
// via plugin-dialog) — contrairement à showDirectoryPicker, c'est une vraie
// fonctionnalité du système d'exploitation, pas une API web à moitié
// implémentée. Le chemin retourné est mémorisé pour les écritures futures.
export async function pickNativeFolder(kind: NativeFolderKind): Promise<string> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ directory: true, multiple: false });
  if (typeof path !== "string") {
    throw new Error("Aucun dossier sélectionné.");
  }
  saveNativeFolderPath(kind, path);
  return path;
}

// Écrit dans le dossier déjà choisi (voir pickNativeFolder) — pas de
// re-sélection à chaque appel, comme pour writeBackupFile côté web.
export async function writeNativeFile(folderPath: string, filename: string, bytes: Uint8Array): Promise<void> {
  const { join } = await import("@tauri-apps/api/path");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const fullPath = await join(folderPath, filename);
  await writeFile(fullPath, bytes);
}

// Pour les documents ponctuels (reçus, tickets, étiquettes, exports de
// rapports) : écrit directement dans le dossier "documents" déjà choisi s'il
// y en a un (voir pickNativeFolder), sinon ouvre la boîte de dialogue "Enregistrer
// sous" native — pas besoin d'avoir configuré un dossier à l'avance pour
// pouvoir exporter un premier document.
export async function saveNativeDocument(filename: string, bytes: Uint8Array): Promise<void> {
  const existingFolder = loadNativeFolderPath("documents");
  if (existingFolder) {
    await writeNativeFile(existingFolder, filename, bytes);
    return;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const path = await save({ defaultPath: filename });
  if (!path) return; // l'utilisateur a annulé — pas une erreur
  await writeFile(path, bytes);
}
