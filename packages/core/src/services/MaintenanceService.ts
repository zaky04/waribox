import type { Database } from "@gestion-boutique/database";
import { hashSecret, verifySecret } from "../auth/hash";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { logAction } from "./AuditService";
import { getSettings, updateSettings } from "./SettingsService";

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
  return verifySecret(code, settings.maintenanceCodeHash);
}

export async function hasMaintenanceCode(db: Database): Promise<boolean> {
  const settings = await getSettings(db);
  return !!settings.maintenanceCodeHash;
}
