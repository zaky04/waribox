import { recordBackup } from "@gestion-boutique/core";
import { exportDatabaseFile, type Database } from "@gestion-boutique/database";
import {
  ensureFolderPermission,
  loadFolderHandle,
  requestGoogleDriveAccessToken,
  uploadToGoogleDrive,
  writeBackupFile,
} from "@gestion-boutique/sync";

export async function runLocalBackup(db: Database): Promise<void> {
  const handle = await loadFolderHandle();
  if (!handle) {
    throw new Error("Aucun dossier de sauvegarde choisi.");
  }
  const granted = await ensureFolderPermission(handle);
  if (!granted) {
    throw new Error("Permission d'écriture refusée pour le dossier de sauvegarde.");
  }

  try {
    const { bytes, filename } = await exportDatabaseFile();
    await writeBackupFile(handle, filename, bytes);
    await recordBackup(db, { destination: "local", fileRef: filename, status: "success" });
  } catch (err) {
    await recordBackup(db, {
      destination: "local",
      status: "error",
      fileRef: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function runGoogleDriveBackup(db: Database, clientId: string): Promise<void> {
  try {
    const accessToken = await requestGoogleDriveAccessToken(clientId);
    const { bytes, filename } = await exportDatabaseFile();
    await uploadToGoogleDrive(accessToken, filename, bytes);
    await recordBackup(db, { destination: "google_drive", fileRef: filename, status: "success" });
  } catch (err) {
    await recordBackup(db, {
      destination: "google_drive",
      status: "error",
      fileRef: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
