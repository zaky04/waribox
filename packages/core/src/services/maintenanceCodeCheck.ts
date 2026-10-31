import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { eq } from "drizzle-orm";
import { verifySecret } from "../auth/hash";

// Même anti-brute-force que AuthService (mot de passe/PIN) — voir son
// commentaire pour le choix des constantes. Bookkeeping écrit directement
// (comme AuthService le fait sur `users`) plutôt que via updateSettings : c'est
// un effet de bord de la vérification elle-même. Fichier séparé de
// SettingsService/MaintenanceService pour éviter tout import circulaire (les
// deux en ont besoin : le code protège aussi l'accès aux réglages avancés).
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;
const SETTINGS_ID = 1;

function remainingLockSeconds(lockedUntil: string | null): number {
  if (!lockedUntil) return 0;
  const until = new Date(`${lockedUntil.replace(" ", "T")}Z`).getTime();
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

// false si aucun code n'est défini ou si le code est faux ; lève si le
// verrouillage temporaire est actif.
export async function checkMaintenanceCode(db: Database, code: string): Promise<boolean> {
  const settings = await db
    .select()
    .from(schema.businessSettings)
    .where(eq(schema.businessSettings.id, SETTINGS_ID))
    .get();
  if (!settings?.maintenanceCodeHash) return false;

  const lockedSeconds = remainingLockSeconds(settings.maintenanceCodeLockedUntil);
  if (lockedSeconds > 0) {
    throw new Error(t("coreErrors.common.tooManyAttempts", { seconds: lockedSeconds }));
  }

  const valid = await verifySecret(code, settings.maintenanceCodeHash);
  if (!valid) {
    const attempts = settings.maintenanceCodeFailedAttempts + 1;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString().replace("T", " ").slice(0, 19);
      await db
        .update(schema.businessSettings)
        .set({ maintenanceCodeFailedAttempts: 0, maintenanceCodeLockedUntil: lockedUntil })
        .where(eq(schema.businessSettings.id, settings.id))
        .run();
    } else {
      await db
        .update(schema.businessSettings)
        .set({ maintenanceCodeFailedAttempts: attempts })
        .where(eq(schema.businessSettings.id, settings.id))
        .run();
    }
    return false;
  }

  await db
    .update(schema.businessSettings)
    .set({ maintenanceCodeFailedAttempts: 0, maintenanceCodeLockedUntil: null })
    .where(eq(schema.businessSettings.id, settings.id))
    .run();
  return true;
}
