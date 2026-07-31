/// <reference path="./fileSystemAccess.d.ts" />

const DB_NAME = "gestion-boutique-sync";
const STORE_NAME = "handles";
const HANDLE_KEY = "backupFolder";

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
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
