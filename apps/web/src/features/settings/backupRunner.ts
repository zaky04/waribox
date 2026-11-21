import {
  decryptBackup,
  enqueueAlert,
  evaluateBackupProbe,
  getSettings,
  isEncryptedBackup,
  recordBackup,
  sameBytes,
  type BackupDestination,
  type BackupVerdict,
} from "@gestion-boutique/core";
import { exportDatabaseFile, probeDatabaseFile, type Database } from "@gestion-boutique/database";
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
import { getBackupPassphrase, protectBackup } from "./backupPassphrase";

// Chaque sauvegarde est TESTÉE avant d'être déclarée réussie : le fichier est rouvert dans une base séparée (en
// mémoire) et contrôlé ; s'il est chiffré, il est déchiffré et comparé à l'original ; s'il est écrit dans un
// dossier, il est relu. Un échec du test n'empêche pas de garder le fichier, mais la sauvegarde est marquée
// « non restaurable », ne compte pas comme réussie (la suivante est donc retentée) et le patron est alerté.
async function verifyProtectedBackup(plain: Uint8Array, written: Uint8Array): Promise<BackupVerdict> {
  let content = written;
  if (isEncryptedBackup(written)) {
    const passphrase = getBackupPassphrase();
    if (!passphrase) return { ok: false, reason: "decrypt" };
    try {
      content = await decryptBackup(written, passphrase);
    } catch {
      return { ok: false, reason: "decrypt" };
    }
    if (!sameBytes(content, plain)) return { ok: false, reason: "decrypt" };
  }
  try {
    return evaluateBackupProbe(await probeDatabaseFile(content));
  } catch {
    return { ok: false, reason: "probe" };
  }
}

export async function createVerifiedBackupFile(): Promise<{ file: { bytes: Uint8Array; filename: string }; verdict: BackupVerdict }> {
  const plain = await exportDatabaseFile();
  const file = await protectBackup(plain);
  return { file, verdict: await verifyProtectedBackup(plain.bytes, file.bytes) };
}

function describeReason(reason: string | undefined): string {
  if (!reason) return "";
  const [code, detail] = reason.split(":");
  return t(`settings.backups.verifyReasons.${code}`, { table: detail ?? "", defaultValue: reason });
}

/** Consigne la sauvegarde dans l'historique selon le résultat du test ; alerte le patron si elle n'est pas restaurable. */
export async function recordBackupOutcome(db: Database, destination: BackupDestination, filename: string, verdict: BackupVerdict): Promise<void> {
  if (verdict.ok) {
    await recordBackup(db, { destination, fileRef: filename, status: "verified" });
    return;
  }
  const reason = describeReason(verdict.reason);
  await recordBackup(db, { destination, fileRef: `${filename} — ${reason}`, status: "verify_failed" });
  const settings = await getSettings(db);
  await enqueueAlert(db, {
    key: `backup:${filename}`,
    severity: "danger",
    text: `${settings.businessName?.trim() ? `[${settings.businessName.trim()}] ` : ""}${t("alerts.backupNotRestorable", { file: filename, reason })}`,
  });
}

/** Relit le fichier écrit dans le dossier choisi : il doit être identique à ce qu'on a écrit. */
async function rereadMatches(handle: FileSystemDirectoryHandle, filename: string, written: Uint8Array): Promise<boolean> {
  try {
    const file = await (await handle.getFileHandle(filename)).getFile();
    return sameBytes(new Uint8Array(await file.arrayBuffer()), written);
  } catch {
    return false;
  }
}

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
    const { file, verdict } = await createVerifiedBackupFile();
    const { bytes, filename } = file;
    if (useNative) {
      await writeToAndroidDownloads(filename, bytes);
    } else if (handle) {
      await writeBackupFile(handle, filename, bytes);
    }
    const written = verdict.ok && handle ? await rereadMatches(handle, filename, bytes) : true;
    await recordBackupOutcome(db, "local", filename, written ? verdict : { ok: false, reason: "reread" });
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
    const { file, verdict } = await createVerifiedBackupFile();
    await uploadToGoogleDrive(accessToken, file.filename, file.bytes);
    await recordBackupOutcome(db, "google_drive", file.filename, verdict);
  } catch (err) {
    await recordBackup(db, {
      destination: "google_drive",
      status: "error",
      fileRef: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
