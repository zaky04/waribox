import { recordBackup } from "@gestion-boutique/core";
import { exportDatabaseFile, type Database } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import {
  ensureFolderPermission,
  isAndroidTauriRuntime,
  loadFolderHandle,
  requestGoogleDriveAccessToken,
  uploadToGoogleDrive,
  writeBackupFile,
  writeToAndroidDownloads,
} from "@gestion-boutique/sync";

export async function runLocalBackup(db: Database): Promise<void> {
  // Sur Android, showDirectoryPicker n'est pas implémenté nativement (voir
  // isFileSystemAccessSupported) — et le sélecteur de dossier natif de
  // plugin-dialog ne l'est pas non plus, confirmé par un test réel sur
  // appareil ("Folder picker is not implemented on mobile", voir journal
  // CLAUDE.md) : on écrit directement dans le dossier Téléchargements
  // standard, sans aucune sélection, plutôt que par l'API web (cassée sur
  // cette plateforme).
  const useNative = isAndroidTauriRuntime();
  const handle = useNative ? null : await loadFolderHandle();

  if (!useNative && !handle) {
    throw new Error(t("settings.backups.errors.noFolderChosen"));
  }
  if (handle) {
    const granted = await ensureFolderPermission(handle);
    if (!granted) {
      throw new Error(t("settings.backups.errors.writePermissionDenied"));
    }
  }

  try {
    const { bytes, filename } = await exportDatabaseFile();
    if (useNative) {
      await writeToAndroidDownloads(filename, bytes);
    } else if (handle) {
      await writeBackupFile(handle, filename, bytes);
    }
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
