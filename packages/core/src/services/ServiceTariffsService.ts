import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { asc, eq } from "drizzle-orm";
import { roundMoney } from "../domain/money";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { logAction } from "./AuditService";

// Tarifs de services — FACULTATIF. Le propriétaire y enregistre ses services
// courants pour que le prix soit contrôlé au comptoir (un prix sous le tarif ou
// une remise exige son approbation). Sans tarif, la saisie des tickets reste
// entièrement manuelle. Un tarif n'est jamais supprimé, seulement désactivé
// (les tickets déjà saisis en gardent une copie du prix de référence).

export async function listServiceTariffs(db: Database, options: { activeOnly?: boolean } = {}) {
  const query = db.select().from(schema.serviceTariffs).orderBy(asc(schema.serviceTariffs.name));
  return options.activeOnly ? query.where(eq(schema.serviceTariffs.isActive, true)) : query;
}

export async function createServiceTariff(
  db: Database,
  input: { name: string; price: number; userId?: number },
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_settings");
  const name = input.name.trim();
  if (!name) throw new Error(t("coreErrors.serviceTariffs.nameRequired"));
  if (!(input.price >= 0)) throw new Error(t("coreErrors.serviceTariffs.priceInvalid"));
  const created = await db
    .insert(schema.serviceTariffs)
    .values({ name, price: roundMoney(input.price) })
    .returning()
    .get();
  await logAction(db, {
    userId: input.userId ?? null,
    action: "create_service_tariff",
    entity: "service_tariff",
    entityId: created.id,
    metadata: { name: created.name, price: created.price },
  });
  return created;
}

export async function updateServiceTariff(
  db: Database,
  id: number,
  input: { name?: string; price?: number; isActive?: boolean },
  userId: number | undefined,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_settings");
  const before = await db.select().from(schema.serviceTariffs).where(eq(schema.serviceTariffs.id, id)).get();
  if (!before) throw new Error(t("coreErrors.serviceTariffs.notFound"));
  const updates: Partial<typeof schema.serviceTariffs.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error(t("coreErrors.serviceTariffs.nameRequired"));
    updates.name = name;
  }
  if (input.price !== undefined) {
    if (!(input.price >= 0)) throw new Error(t("coreErrors.serviceTariffs.priceInvalid"));
    updates.price = roundMoney(input.price);
  }
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  const updated = await db.update(schema.serviceTariffs).set(updates).where(eq(schema.serviceTariffs.id, id)).returning().get();
  await logAction(db, {
    userId: userId ?? null,
    action: "update_service_tariff",
    entity: "service_tariff",
    entityId: id,
    // Ancien et nouveau prix : changer un tarif doit laisser une trace.
    metadata: { before: { name: before.name, price: before.price, isActive: before.isActive }, after: { name: updated.name, price: updated.price, isActive: updated.isActive } },
  });
  return updated;
}
