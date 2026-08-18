/// <reference path="./fileSystemAccess.d.ts" />

const DB_NAME = "gestion-boutique-sync";
const STORE_NAME = "handles";
const HANDLE_KEY = "backupFolder";

// Chrome pour Android (et le WebView Android utilisé par Tauri, qui partage
// le même moteur) expose `showDirectoryPicker` dans `window` — la simple
// détection de fonctionnalité répond donc "oui" — mais n'a jamais livré
// l'interface native de sélection de dossier : l'appel rejette
// immédiatement avec un AbortError générique ("The user aborted a
// request"), pas un vrai refus utilisateur. Exclu explicitement par
// user-agent, même détection que isDesktopTauriRuntime() dans
// apps/web/src/features/settings/tauriRuntime.ts et pour la même raison
// (pas de @tauri-apps/plugin-os installé dans ce projet).
export function isFileSystemAccessSupported(): boolean {
  if (typeof window === "undefined" || !("showDirectoryPicker" in window)) return false;
  if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)) return false;
  return true;
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openHandleDb();
  const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
    request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return handle;
}

export async function pickBackupFolder(): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await saveFolderHandle(handle);
  return handle;
}

export async function ensureFolderPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const options = { mode: "readwrite" as const };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

export async function writeBackupFile(
  handle: FileSystemDirectoryHandle,
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  const fileHandle = await handle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(new Uint8Array(bytes));
  await writable.close();
}
