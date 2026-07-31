import { getLastSuccessfulBackup, getSettings, isBackupDue } from "@gestion-boutique/core";
import { loadFolderHandle } from "@gestion-boutique/sync";
import { useEffect } from "react";
import { useDatabase } from "../../app/DatabaseProvider";
import { runGoogleDriveBackup, runLocalBackup } from "./backupRunner";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Tourne tant que l'app est ouverte, indépendamment de l'onglet actif (monté
// une fois dans MainContent). Les échecs sont consignés dans l'historique par
// backupRunner — pas besoin de les remonter ici, l'utilisateur les verra dans
// Paramètres et pourra relancer manuellement.
export function useBackupScheduler(): void {
  const db = useDatabase();

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      const settings = await getSettings(db);
      if (cancelled) return;

      const localLast = await getLastSuccessfulBackup(db, "local");
      if (isBackupDue(localLast?.createdAt ?? null, settings.backupFrequency)) {
        const handle = await loadFolderHandle();
        if (handle) {
          try {
            await runLocalBackup(db);
          } catch {
            // consigné par runLocalBackup
          }
        }
      }

      if (cancelled) return;

      const driveLast = await getLastSuccessfulBackup(db, "google_drive");
      if (settings.googleDriveClientId && isBackupDue(driveLast?.createdAt ?? null, settings.backupFrequency)) {
        try {
          await runGoogleDriveBackup(db, settings.googleDriveClientId);
        } catch {
          // consigné par runGoogleDriveBackup
        }
      }
    };

    check();
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [db]);
}
