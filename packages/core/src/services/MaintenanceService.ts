import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { hashSecret, verifySecret } from "../auth/hash";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { logAction } from "./AuditService";
import { getSettings, updateSettings } from "./SettingsService";

// Même anti-brute-force que AuthService (mot de passe/PIN) — voir son
// commentaire pour le choix des constantes. Bookkeeping écrit directement
// (comme AuthService le fait sur `users`, pas via updateUser) plutôt que via
// updateSettings, qui exige déjà manage_settings — ici c'est un effet de bord
// de la vérification elle-même, pas un changement de paramètres à part entière.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;

function remainingLockSeconds(lockedUntil: string | null): number {
  if (!lockedUntil) return 0;
  const until = new Date(`${lockedUntil.replace(" ", "T")}Z`).getTime();
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

export interface SetMaintenanceCodeInput {
  newCode: string;
  currentCode?: string;
  userId: number;
  actingPermissions: PermissionSet;
}

// Secret séparé des comptes utilisateurs (voir schema/settings.ts) — protège
// les actions de maintenance sensibles (installation d'une mise à jour) sans
// dépendre du mot de passe Admin du client, utile quand c'est le technicien
// qui déclenche l'action sur place.
export async function setMaintenanceCode(db: Database, input: SetMaintenanceCodeInput): Promise<void> {
  requirePermission(input.actingPermissions, "manage_settings");
  if (input.newCode.length < 6) {
    throw new Error("Le code de maintenance doit contenir au moins 6 caractères.");
  }

  const settings = await getSettings(db);
  if (settings.maintenanceCodeHash) {
    if (!input.currentCode) {
      throw new Error("Le code de maintenance actuel est requis pour le changer.");
    }
    const valid = await verifySecret(input.currentCode, settings.maintenanceCodeHash);
    if (!valid) {
      throw new Error("Code de maintenance actuel incorrect.");
    }
  }

  const maintenanceCodeHash = await hashSecret(input.newCode);
  await updateSettings(db, { maintenanceCodeHash }, input.actingPermissions);

  await logAction(db, {
    userId: input.userId,
    action: settings.maintenanceCodeHash ? "change_maintenance_code" : "set_maintenance_code",
    entity: "business_settings",
  });
}

export async function verifyMaintenanceCode(db: Database, code: string): Promise<boolean> {
  const settings = await getSettings(db);
  if (!settings.maintenanceCodeHash) return false;

  const lockedSeconds = remainingLockSeconds(settings.maintenanceCodeLockedUntil);
  if (lockedSeconds > 0) {
    throw new Error(`Trop de tentatives. Réessaie dans ${lockedSeconds} seconde(s).`);
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

export async function hasMaintenanceCode(db: Database): Promise<boolean> {
  const settings = await getSettings(db);
  return !!settings.maintenanceCodeHash;
}
