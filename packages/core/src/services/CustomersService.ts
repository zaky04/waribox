import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { logAction } from "./AuditService";
import { requirePermission, type PermissionSet } from "../domain/permissions";

export async function listCustomers(db: Database) {
  return db.select().from(schema.customers);
}

export interface CreateCustomerInput {
  fullName: string;
  phone?: string;
  email?: string;
  address?: string;
  createdBy?: number;
}

// Primitive interne partagée par createCustomer (action explicite, gardée
// par manage_customers) et findOrCreateCustomerByName*/ (raccourci "client de
// passage" invoqué depuis les ventes/devis/tickets de service, déjà gardés
// par leur propre permission — pas de double-garde ici, sinon un Caissier
// sans manage_customers ne pourrait plus saisir de nouveau client au comptoir).
async function insertCustomer(
  db: Database,
  input: { fullName: string; phone?: string; email?: string; address?: string },
) {
  return db
    .insert(schema.customers)
    .values({
      fullName: input.fullName,
      phone: input.phone,
      email: input.email,
      address: input.address,
    })
    .returning()
    .get();
}

export async function createCustomer(
  db: Database,
  input: CreateCustomerInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_customers");
  const customer = await insertCustomer(db, input);

  if (input.createdBy) {
    await logAction(db, {
      userId: input.createdBy,
      action: "create_customer",
      entity: "customer",
      entityId: customer.id,
      metadata: { fullName: customer.fullName },
    });
  }

  return customer;
}

export interface UpdateCustomerInput {
  fullName?: string;
  phone?: string;
  email?: string;
  address?: string;
  createdBy?: number;
}

export async function updateCustomer(
  db: Database,
  id: number,
  input: UpdateCustomerInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "edit_customers");
  const customer = await db
    .update(schema.customers)
    .set({
      fullName: input.fullName,
      phone: input.phone,
      email: input.email,
      address: input.address,
    })
    .where(eq(schema.customers.id, id))
    .returning()
    .get();

  if (input.createdBy) {
    await logAction(db, {
      userId: input.createdBy,
      action: "update_customer",
      entity: "customer",
      entityId: customer.id,
      metadata: { fullName: customer.fullName },
    });
  }

  return customer;
}

// Réutilise un client existant portant exactement ce nom plutôt que d'en
// recréer un — évite les doublons quand un même nom est soumis deux fois
// (ex: nouvelle tentative après une vente refusée pour stock insuffisant).
export async function findOrCreateCustomerByName(db: Database, fullName: string) {
  const existing = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.fullName, fullName))
    .get();
  if (existing) return existing;
  return insertCustomer(db, { fullName });
}

// Variante pour les tickets de service : le téléphone identifie plus
// fiablement un client de passage qu'un nom (homonymes fréquents), donc on le
// cherche en priorité avant de retomber sur la correspondance par nom exact.
export async function findOrCreateCustomerByNameAndPhone(
  db: Database,
  fullName: string,
  phone?: string,
) {
  const trimmedPhone = phone?.trim();
  if (trimmedPhone) {
    const byPhone = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.phone, trimmedPhone))
      .get();
    if (byPhone) return byPhone;
  }

  const existing = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.fullName, fullName))
    .get();
  if (existing) return existing;

  return insertCustomer(db, { fullName, phone: trimmedPhone });
}
