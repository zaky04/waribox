import { recordBackup } from "@gestion-boutique/core";
import { exportDatabaseFile, type Database } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import {
  ensureFolderPermission,
  isAndroidTauriRuntime,
  loadFolderHandle,
  loadNativeFolderPath,
  requestGoogleDriveAccessToken,
  uploadToGoogleDrive,
  writeBackupFile,
  writeNativeFile,
} from "@gestion-boutique/sync";

export async function runLocalBackup(db: Database): Promise<void> {
  // Sur Android, showDirectoryPicker n'est pas implémenté nativement (voir
  // isFileSystemAccessSupported) — on passe par un vrai dossier natif choisi
  // via plugin-dialog/plugin-fs (voir SettingsPage.tsx, bloc "Sauvegarde
  // locale") plutôt que par l'API web, cassée sur cette plateforme.
  const useNative = isAndroidTauriRuntime();
  const nativeFolderPath = useNative ? loadNativeFolderPath("backup") : null;
  const handle = useNative ? null : await loadFolderHandle();

  if (useNative ? !nativeFolderPath : !handle) {
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
    if (nativeFolderPath) {
      await writeNativeFile(nativeFolderPath, filename, bytes);
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
