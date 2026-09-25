import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { eq } from "drizzle-orm";
import {
  DEFAULT_ROLES,
  PERMISSIONS,
  assertCanChangePermissions,
  mergeMissingPermissions,
  requirePermission,
  type DefaultRoleKey,
  type PermissionSet,
} from "../domain/permissions";
import { logAction } from "./AuditService";

// Idempotent : crée les rôles par défaut s'ils n'existent pas encore (par nom),
// puis retourne l'id de chacun. Appelé au démarrage de l'app.
//
// Pour un rôle déjà existant (installation déjà déployée), rattrape aussi les
// permissions ajoutées depuis — sans jamais retirer une permission déjà
// accordée — pour qu'une mise à jour du code n'exige pas de recréer les
// comptes ni de reconfigurer manuellement les rôles.
export async function ensureDefaultRoles(db: Database): Promise<Record<DefaultRoleKey, number>> {
  const result = {} as Record<DefaultRoleKey, number>;

  for (const key of Object.keys(DEFAULT_ROLES) as DefaultRoleKey[]) {
    const role = DEFAULT_ROLES[key];
    const existing = await db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.name, role.name))
      .get();

    if (existing) {
      result[key] = existing.id;
      const currentPermissions = JSON.parse(existing.permissions) as PermissionSet;
      const { merged, changed } = mergeMissingPermissions(currentPermissions, role.permissions);
      if (changed) {
        await db
          .update(schema.roles)
          .set({ permissions: JSON.stringify(merged) })
          .where(eq(schema.roles.id, existing.id));
      }
      continue;
    }

    const created = await db
      .insert(schema.roles)
      .values({ name: role.name, permissions: JSON.stringify(role.permissions) })
      .returning()
      .get();

    result[key] = created.id;
  }

  return result;
}

// Le rôle Admin garde toujours toutes les permissions (impossible de se
// verrouiller hors de l'application).
const PROTECTED_ROLE = DEFAULT_ROLES.admin.name;

function cleanPermissions(input: PermissionSet): PermissionSet {
  const out: PermissionSet = {};
  for (const key of PERMISSIONS) out[key] = input[key] === true;
  return out;
}

export interface SaveRoleInput {
  name: string;
  permissions: PermissionSet;
  userId?: number;
}

export async function createRole(db: Database, input: SaveRoleInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_users");
  const name = input.name.trim();
  if (!name) throw new Error(t("coreErrors.roles.nameRequired"));
  const existing = await db.select().from(schema.roles).where(eq(schema.roles.name, name)).get();
  if (existing) throw new Error(t("coreErrors.roles.nameTaken"));
  assertCanChangePermissions(actingPermissions, {}, cleanPermissions(input.permissions));
  const role = await db
    .insert(schema.roles)
    .values({ name, permissions: JSON.stringify(cleanPermissions(input.permissions)) })
    .returning()
    .get();
  await logAction(db, { userId: input.userId ?? null, action: "create_role", entity: "role", entityId: role.id, metadata: { name, permissions: role.permissions } });
  return role;
}

export async function updateRolePermissions(
  db: Database,
  roleId: number,
  input: { permissions: PermissionSet; userId?: number },
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_users");
  const role = await db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();
  if (!role) throw new Error(t("coreErrors.roles.notFound"));
  if (role.name === PROTECTED_ROLE) throw new Error(t("coreErrors.roles.adminLocked"));
  const next = cleanPermissions(input.permissions);
  assertCanChangePermissions(actingPermissions, JSON.parse(role.permissions) as PermissionSet, next);
  const updated = await db
    .update(schema.roles)
    .set({ permissions: JSON.stringify(next) })
    .where(eq(schema.roles.id, roleId))
    .returning()
    .get();
  await logAction(db, {
    userId: input.userId ?? null,
    action: "update_role",
    entity: "role",
    entityId: roleId,
    metadata: { name: role.name, before: role.permissions, after: updated.permissions },
  });
  return updated;
}
