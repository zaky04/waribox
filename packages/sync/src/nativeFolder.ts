// Écriture de fichier native sur Android, où ni l'API web File System Access
// (voir folderHandle.ts) ni le repli "téléchargement" (blob URL +
// <a download>, WebView Android sans gestionnaire de téléchargement
// intégré) ne fonctionnent.
//
// Historique (voir CLAUDE.md pour le détail complet) :
// 1. Une première version laissait choisir un dossier via plugin-dialog
//    (`open({ directory: true })`). Testé sur un vrai appareil : rejette
//    immédiatement avec "Folder picker is not implemented on mobile" — pas
//    implémenté sur mobile, quelle que soit la configuration.
// 2. Une deuxième version écrivait via `@tauri-apps/plugin-fs` avec
//    `BaseDirectory.Download`. Testé sur un vrai appareil (BlueStacks) :
//    l'écriture "réussit" (aucune erreur, entrée "Réussie" dans
//    l'historique) mais le fichier reste introuvable. Cause once lue dans
//    le code source de tauri (`PathPlugin.kt`, `getDownloadDir()`) :
//    `BaseDirectory.Download` résout sur Android vers
//    `getExternalFilesDir(DIRECTORY_DOWNLOADS)` — un dossier PRIVÉ à l'app
//    (`/Android/data/<package>/files/Download`), pas le dossier
//    Téléchargements public visible dans l'app Fichiers. Une limitation du
//    résolveur de chemins de Tauri lui-même sur Android, pas de notre
//    configuration.
// 3. Solution actuelle : `tauri-plugin-android-fs` (crate tiers,
//    https://github.com/aiueo13/tauri-plugin-android-fs), qui écrit via
//    l'API MediaStore d'Android — le mécanisme officiellement recommandé
//    par Google pour qu'un fichier atterrisse réellement dans le dossier
//    Téléchargements public partagé, visible par les autres apps. Gère
//    aussi la permission d'exécution requise sur Android 9 et inférieur
//    (voir le feature `legacy_storage_permission` dans Cargo.toml).
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

// Écrit dans le dossier Téléchargements PUBLIC de l'appareil via MediaStore
// (createNewPublicFile + writeFile de tauri-plugin-android-fs-api) — pas de
// sélection de dossier, pas de boîte de dialogue dans le cas courant
// (Android 10+). Sur Android 9 et inférieur, la permission de stockage est
// demandée automatiquement au premier appel (voir requestPermission, activé
// par défaut) grâce au feature `legacy_storage_permission` déclaré côté
// Rust. `mimeType: null` laisse le plugin l'inférer depuis l'extension du
// nom de fichier. Si un fichier du même nom existe déjà, un suffixe
// numérique est ajouté automatiquement — comportement standard de
// téléchargement, pas un bug.
export async function writeToAndroidDownloads(filename: string, bytes: Uint8Array): Promise<void> {
  const { createNewPublicFile, writeFile, PublicGeneralPurposeDir } = await import("tauri-plugin-android-fs-api");
  const uri = await createNewPublicFile(PublicGeneralPurposeDir.Download, filename, null);
  await writeFile(uri, bytes);
}
