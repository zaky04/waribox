import { encryptBackup, ENCRYPTED_BACKUP_EXTENSION } from "@gestion-boutique/core";

// Mot de passe de chiffrement des sauvegardes. Gardé sur CET appareil (localStorage,
// comme la langue ou le thème) et jamais dans la base : une sauvegarde qui contiendrait
// son propre mot de passe n'aurait aucun intérêt, et la base est justement ce qui voyage.
// Il permet aux sauvegardes automatiques de se chiffrer sans rien demander ; sans lui
// (autre appareil, données du navigateur effacées), il se ressaisit à la restauration.
const STORAGE_KEY = "waribox-backup-passphrase";

export function getBackupPassphrase(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function setBackupPassphrase(passphrase: string | null): void {
  try {
    if (passphrase) localStorage.setItem(STORAGE_KEY, passphrase);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // stockage indisponible : la sauvegarde restera non chiffrée
  }
}

/** Chiffre le fichier de sauvegarde si un mot de passe est défini (extension .enc ajoutée), sinon le laisse tel quel. */
export async function protectBackup(file: { bytes: Uint8Array; filename: string }): Promise<{ bytes: Uint8Array; filename: string }> {
  const passphrase = getBackupPassphrase();
  if (!passphrase) return file;
  return { bytes: await encryptBackup(file.bytes, passphrase), filename: file.filename + ENCRYPTED_BACKUP_EXTENSION };
}
