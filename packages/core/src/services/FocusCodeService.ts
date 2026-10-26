import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { eq } from "drizzle-orm";
import { hashSecret, verifySecret } from "../auth/hash";
import { lockoutSecondsForAttempts, remainingLockSeconds } from "../auth/lockout";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { logAction } from "./AuditService";
import { checkMaintenanceCode } from "./maintenanceCodeCheck";

// Code du mode focus : il sert uniquement à quitter le plein écran sur PC et
// tablette. C'est un secret à part, ni le code de maintenance (qui ouvre la
// configuration avancée) ni un PIN de compte : on peut le confier à un gérant
// sans lui donner le reste. Le code de maintenance sert de secours si le code
// du mode focus est oublié (sinon l'appareil resterait coincé en plein écran) :
// l'interface le propose via « code oublié », voir verifyMaintenanceCode.
export const FOCUS_CODE_MIN_LENGTH = 4;
const SETTINGS_ID = 1;

export interface SetFocusCodeInput {
  newCode: string;
  // Pour modifier un code déjà défini, l'un des deux est exigé : le code du mode
  // focus actuel, ou (s'il est oublié) le code de maintenance.
  currentCode?: string;
  maintenanceCode?: string;
  userId: number;
  actingPermissions: PermissionSet;
}

async function loadSettingsRow(db: Database) {
  return db.select().from(schema.businessSettings).where(eq(schema.businessSettings.id, SETTINGS_ID)).get();
}

// Vérifie UNIQUEMENT le code du mode focus (compteur d'essais progressif).
// false si aucun code n'est défini ou si le code est faux ; lève pendant un verrouillage.
async function checkOwnFocusCode(db: Database, code: string): Promise<boolean> {
  const settings = await loadSettingsRow(db);
  if (!settings?.focusCodeHash) return false;

  const lockedSeconds = remainingLockSeconds(settings.focusCodeLockedUntil);
  if (lockedSeconds > 0) throw new Error(t("coreErrors.common.tooManyAttempts", { seconds: lockedSeconds }));

  const valid = await verifySecret(code, settings.focusCodeHash);
  if (!valid) {
    const attempts = settings.focusCodeFailedAttempts + 1;
    const lockSeconds = lockoutSecondsForAttempts(attempts);
    const lockedUntil = lockSeconds > 0 ? new Date(Date.now() + lockSeconds * 1000).toISOString().replace("T", " ").slice(0, 19) : null;
    await db
      .update(schema.businessSettings)
      .set(lockedUntil ? { focusCodeFailedAttempts: attempts, focusCodeLockedUntil: lockedUntil } : { focusCodeFailedAttempts: attempts })
      .where(eq(schema.businessSettings.id, settings.id))
      .run();
    return false;
  }

  await db
    .update(schema.businessSettings)
    .set({ focusCodeFailedAttempts: 0, focusCodeLockedUntil: null })
    .where(eq(schema.businessSettings.id, settings.id))
    .run();
  return true;
}

export async function hasFocusCode(db: Database): Promise<boolean> {
  const settings = await loadSettingsRow(db);
  return !!settings?.focusCodeHash;
}

// Vrai si c'est le bon code du mode focus. Sans code défini, retourne false
// (l'appelant teste hasFocusCode d'abord : sans code, la sortie est libre).
// Le code de maintenance, qui sert de secours si le code focus est oublié,
// se vérifie séparément (verifyMaintenanceCode) : chaque secret garde son propre
// compteur d'essais, une erreur de saisie ici ne bloque donc pas la maintenance.
export async function verifyFocusCode(db: Database, code: string): Promise<boolean> {
  return checkOwnFocusCode(db, code);
}

export async function setFocusCode(db: Database, input: SetFocusCodeInput): Promise<void> {
  requirePermission(input.actingPermissions, "manage_settings");
  if (input.newCode.length < FOCUS_CODE_MIN_LENGTH) {
    throw new Error(t("coreErrors.focus.codeTooShort", { min: FOCUS_CODE_MIN_LENGTH }));
  }

  const settings = await loadSettingsRow(db);
  if (!settings) throw new Error(t("coreErrors.focus.settingsMissing"));
  if (settings.focusCodeHash) {
    if (input.maintenanceCode) {
      if (!(await checkMaintenanceCode(db, input.maintenanceCode))) throw new Error(t("coreErrors.focus.wrongMaintenanceCode"));
    } else {
      if (!input.currentCode) throw new Error(t("coreErrors.focus.currentCodeRequired"));
      if (!(await verifyFocusCode(db, input.currentCode))) throw new Error(t("coreErrors.focus.wrongCurrentCode"));
    }
  }

  const focusCodeHash = await hashSecret(input.newCode);
  // Écriture directe : updateSettings refuse volontairement ce champ.
  await db
    .update(schema.businessSettings)
    .set({ focusCodeHash, focusCodeFailedAttempts: 0, focusCodeLockedUntil: null })
    .where(eq(schema.businessSettings.id, settings.id))
    .run();

  await logAction(db, {
    userId: input.userId,
    action: settings.focusCodeHash ? "change_focus_code" : "set_focus_code",
    entity: "business_settings",
  });
}
