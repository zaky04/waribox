import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { DEFAULT_ROLES, mergeMissingPermissions, type DefaultRoleKey, type PermissionSet } from "../domain/permissions";

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
