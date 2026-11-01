import { exportDatabaseFile, type Database } from "@gestion-boutique/database";
import type { TFunction } from "i18next";
import { saveGeneratedFile } from "../../lib/saveFile";
import { protectBackup } from "../settings/backupPassphrase";

// Se relier à un Maître REMPLACE toutes les données de l'appareil par les siennes (voir resetBusinessData dans
// packages/core/src/sync/snapshot.ts) : produits, clients, ventes, stock. L'utilisateur est prévenu, et une copie de
// sécurité de la base est enregistrée AVANT de continuer (chiffrée si un mot de passe de sauvegarde est défini).
// Renvoie faux si l'utilisateur renonce.
export async function confirmReplaceLocalData(_db: Database, t: TFunction, confirmKey: string): Promise<boolean> {
  if (!window.confirm(t(confirmKey))) return false;
  try {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const file = await protectBackup({ ...(await exportDatabaseFile()), filename: `avant-reseau-${stamp}.sqlite3` });
    await saveGeneratedFile(new Blob([new Uint8Array(file.bytes)]), file.filename);
  } catch {
    // Pas de copie : on ne remplace pas des données sans filet sans l'accord explicite de l'utilisateur.
    return window.confirm(t("network.joinBackupFailed"));
  }
  return true;
}
