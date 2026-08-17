import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { asc, eq } from "drizzle-orm";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { ensureLocationsForStore } from "./StockService";

export async function listStores(db: Database) {
  return db.select().from(schema.stores).orderBy(asc(schema.stores.id));
}

// La toute première boutique (par id) sert de boutique par défaut — celle à
// laquelle sont rattachées toutes les données existantes en mode
// mono-boutique (voir MIGRATION_SQL dans client.ts).
export async function getDefaultStore(db: Database) {
  const store = await db.select().from(schema.stores).orderBy(asc(schema.stores.id)).get();
  if (!store) {
    throw new Error(t("coreErrors.stores.noStoreExists"));
  }
  return store;
}

export interface CreateStoreInput {
  name: string;
  address?: string;
  phone?: string;
}

export async function createStore(db: Database, input: CreateStoreInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_settings");
  const store = await db
    .insert(schema.stores)
    .values({ name: input.name, address: input.address, phone: input.phone })
    .returning()
    .get();

  // Chaque boutique a immédiatement sa propre Réserve/Surface de vente —
  // évite un état transitoire où une boutique neuve n'a nulle part où
  // recevoir un achat ou vendre.
  await ensureLocationsForStore(db, store.id);

  return store;
}

export interface UpdateStoreInput {
  name?: string;
  address?: string;
  phone?: string;
  isActive?: boolean;
}

export async function updateStore(
  db: Database,
  storeId: number,
  input: UpdateStoreInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_settings");
  return db.update(schema.stores).set(input).where(eq(schema.stores.id, storeId)).returning().get();
}
