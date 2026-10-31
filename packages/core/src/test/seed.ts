import type { Database } from "@gestion-boutique/database";
import { createUser, type AuthenticatedUser } from "../auth/AuthService";
import type { DefaultRoleKey } from "../domain/permissions";
import { ensureDefaultRoles } from "../services/RolesService";
import { getDefaultStore } from "../services/StoresService";
import { ensureLocationsForStore } from "../services/StockService";

export const ADMIN_PIN = "482915";
export const MANAGER_PIN = "246810";
export const CASHIER_PIN = "135790";
// PIN d'approbation : volontairement différents des PIN de déverrouillage.
export const ADMIN_APPROVAL_PIN = "731864";
export const MANAGER_APPROVAL_PIN = "902357";
export const CASHIER_APPROVAL_PIN = "518406";

export interface SeededBusiness {
  roles: Record<DefaultRoleKey, number>;
  storeId: number;
  locations: { reserve: number; surface: number };
  admin: AuthenticatedUser;
  manager: AuthenticatedUser;
  cashier: AuthenticatedUser;
}

// Une entreprise minimale mais réelle : rôles par défaut, boutique et
// emplacements, un administrateur (seul à pouvoir approuver), un gérant et un
// caissier, chacun avec un code PIN.
export async function seedBusiness(db: Database): Promise<SeededBusiness> {
  const roles = await ensureDefaultRoles(db);
  const store = await getDefaultStore(db);
  const locs = await ensureLocationsForStore(db, store.id);
  const admin = await createUser(db, { fullName: "Admin", username: "admin", password: "motdepasse-admin", pin: ADMIN_PIN, approvalPin: ADMIN_APPROVAL_PIN, roleId: roles.admin }, {});
  const manager = await createUser(db, { fullName: "Gérant", username: "gerant", password: "motdepasse-gerant", pin: MANAGER_PIN, approvalPin: MANAGER_APPROVAL_PIN, roleId: roles.gerant }, admin.permissions);
  const cashier = await createUser(db, { fullName: "Caissier", username: "caissier", password: "motdepasse-caisse", pin: CASHIER_PIN, approvalPin: CASHIER_APPROVAL_PIN, roleId: roles.caissier, storeId: store.id }, admin.permissions);
  return {
    roles,
    storeId: store.id,
    locations: { reserve: locs.reserve, surface: locs.surface_vente },
    admin,
    manager,
    cashier,
  };
}
