import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { eq } from "drizzle-orm";
import { hashSecret } from "../auth/hash";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { logAction } from "./AuditService";
import { checkMaintenanceCode } from "./maintenanceCodeCheck";
import { getSettings } from "./SettingsService";

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
    throw new Error(t("coreErrors.maintenance.codeTooShort"));
  }

  const settings = await getSettings(db);
  if (settings.maintenanceCodeHash) {
    if (!input.currentCode) {
      throw new Error(t("coreErrors.maintenance.currentCodeRequired"));
    }
    // Passe par le même compteur d'essais que le déverrouillage : sans ça, le
    // code actuel pouvait être deviné sans limite via cette fonction.
    const valid = await checkMaintenanceCode(db, input.currentCode);
    if (!valid) {
      throw new Error(t("coreErrors.maintenance.wrongCurrentCode"));
    }
  }

  const maintenanceCodeHash = await hashSecret(input.newCode);
  // Écriture directe : updateSettings refuse volontairement ce champ (voir son commentaire).
  await db
    .update(schema.businessSettings)
    .set({ maintenanceCodeHash, maintenanceCodeFailedAttempts: 0, maintenanceCodeLockedUntil: null })
    .where(eq(schema.businessSettings.id, settings.id))
    .run();

  await logAction(db, {
    userId: input.userId,
    action: settings.maintenanceCodeHash ? "change_maintenance_code" : "set_maintenance_code",
    entity: "business_settings",
  });
}

export async function verifyMaintenanceCode(db: Database, code: string): Promise<boolean> {
  return checkMaintenanceCode(db, code);
}

export async function hasMaintenanceCode(db: Database): Promise<boolean> {
  const settings = await getSettings(db);
  return !!settings.maintenanceCodeHash;
}
