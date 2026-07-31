import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { logAction } from "./AuditService";

export async function listSuppliers(db: Database) {
  return db.select().from(schema.suppliers);
}

export interface CreateSupplierInput {
  name: string;
  phone?: string;
  contactPerson?: string;
  createdBy?: number;
}

export async function createSupplier(db: Database, input: CreateSupplierInput) {
  const supplier = await db
    .insert(schema.suppliers)
    .values({
      name: input.name,
      phone: input.phone,
      contactPerson: input.contactPerson,
    })
    .returning()
    .get();

  if (input.createdBy) {
    await logAction(db, {
      userId: input.createdBy,
      action: "create_supplier",
      entity: "supplier",
      entityId: supplier.id,
      metadata: { name: supplier.name },
    });
  }

  return supplier;
}

export interface UpdateSupplierInput {
  name?: string;
  phone?: string;
  contactPerson?: string;
  createdBy?: number;
}

export async function updateSupplier(db: Database, id: number, input: UpdateSupplierInput) {
  const supplier = await db
    .update(schema.suppliers)
    .set({
      name: input.name,
      phone: input.phone,
      contactPerson: input.contactPerson,
    })
    .where(eq(schema.suppliers.id, id))
    .returning()
    .get();

  if (input.createdBy) {
    await logAction(db, {
      userId: input.createdBy,
      action: "update_supplier",
      entity: "supplier",
      entityId: supplier.id,
      metadata: { name: supplier.name },
    });
  }

  return supplier;
}
