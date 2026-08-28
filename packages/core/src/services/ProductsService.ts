import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { eq } from "drizzle-orm";
import { logAction } from "./AuditService";
import { requirePermission, type PermissionSet } from "../domain/permissions";

export interface CategoryInput {
  name: string;
  parentId?: number | null;
  createdBy?: number;
}

export async function listCategories(db: Database) {
  return db.select().from(schema.categories);
}

export async function createCategory(db: Database, input: CategoryInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_products");
  const category = await db
    .insert(schema.categories)
    .values({ name: input.name, parentId: input.parentId ?? null })
    .returning()
    .get();

  if (input.createdBy) {
    await logAction(db, {
      userId: input.createdBy,
      action: "create_category",
      entity: "category",
      entityId: category.id,
      metadata: { name: category.name },
    });
  }

  return category;
}

export interface ProductInput {
  name: string;
  categoryId?: number | null;
  unit?: string;
  purchasePrice: number;
  salePrice: number;
  taxRate?: number | null;
  lowStockThreshold?: number;
  trackExpiry?: boolean;
  barcode?: string | null;
  createdBy?: number;
}

export interface ProductWithVariant {
  product: typeof schema.products.$inferSelect;
  defaultVariant: typeof schema.productVariants.$inferSelect;
}

// Chaque produit possède toujours au moins une variante "de base" (attributes: {})
// pour rester vendable même sans déclinaisons (taille/couleur, etc.).
export async function createProduct(
  db: Database,
  input: ProductInput,
  actingPermissions: PermissionSet,
): Promise<ProductWithVariant> {
  requirePermission(actingPermissions, "manage_products");
  const product = await db
    .insert(schema.products)
    .values({
      name: input.name,
      categoryId: input.categoryId ?? null,
      unit: input.unit ?? "unite",
      hasVariants: false,
      trackExpiry: input.trackExpiry ?? false,
      purchasePrice: input.purchasePrice,
      salePrice: input.salePrice,
      taxRate: input.taxRate ?? null,
      lowStockThreshold: input.lowStockThreshold ?? 5,
    })
    .returning()
    .get();

  const defaultVariant = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      attributes: "{}",
      barcode: input.barcode || null,
    })
    .returning()
    .get();

  if (input.createdBy) {
    await logAction(db, {
      userId: input.createdBy,
      action: "create_product",
      entity: "product",
      entityId: product.id,
      metadata: { name: product.name, salePrice: product.salePrice },
    });
  }

  return { product, defaultVariant };
}

export interface UpdateProductInput {
  name?: string;
  categoryId?: number | null;
  unit?: string;
  purchasePrice?: number;
  salePrice?: number;
  taxRate?: number | null;
  lowStockThreshold?: number;
  trackExpiry?: boolean;
  updatedBy?: number;
}

export async function updateProduct(
  db: Database,
  productId: number,
  input: UpdateProductInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_products");
  const updates: Partial<typeof schema.products.$inferInsert> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.categoryId !== undefined) updates.categoryId = input.categoryId;
  if (input.unit !== undefined) updates.unit = input.unit;
  if (input.purchasePrice !== undefined) updates.purchasePrice = input.purchasePrice;
  if (input.salePrice !== undefined) updates.salePrice = input.salePrice;
  if (input.taxRate !== undefined) updates.taxRate = input.taxRate;
  if (input.lowStockThreshold !== undefined) updates.lowStockThreshold = input.lowStockThreshold;
  if (input.trackExpiry !== undefined) updates.trackExpiry = input.trackExpiry;

  const updated = await db
    .update(schema.products)
    .set(updates)
    .where(eq(schema.products.id, productId))
    .returning()
    .get();
  if (!updated) {
    throw new Error(t("coreErrors.products.notFound"));
  }

  if (input.updatedBy) {
    await logAction(db, {
      userId: input.updatedBy,
      action: "update_product",
      entity: "product",
      entityId: productId,
      metadata: { name: updated.name, salePrice: updated.salePrice },
    });
  }

  return updated;
}

// Le code-barres vit sur la variante par défaut, pas sur le produit — voir
// createProduct, qui crée toujours une variante "de base" sans attribut.
export async function updateVariantBarcode(
  db: Database,
  variantId: number,
  barcode: string | null,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_products");
  return db
    .update(schema.productVariants)
    .set({ barcode })
    .where(eq(schema.productVariants.id, variantId))
    .returning()
    .get();
}

export interface VariantInput {
  productId: number;
  attributes: Record<string, string>;
  sku?: string;
  barcode?: string;
  priceOverride?: number;
}

export async function createVariant(db: Database, input: VariantInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_products");
  await db
    .update(schema.products)
    .set({ hasVariants: true })
    .where(eq(schema.products.id, input.productId))
    .run();

  return db
    .insert(schema.productVariants)
    .values({
      productId: input.productId,
      attributes: JSON.stringify(input.attributes),
      sku: input.sku,
      barcode: input.barcode,
      priceOverride: input.priceOverride,
    })
    .returning()
    .get();
}

export async function listVariantsByProduct(db: Database, productId: number) {
  return db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, productId));
}

export async function listProducts(db: Database) {
  return db.select().from(schema.products);
}

export async function listAllVariants(db: Database) {
  return db.select().from(schema.productVariants);
}

function ean13CheckDigit(digits12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(digits12[i]);
    sum += i % 2 === 0 ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}

// Génère un EAN-13 dans la plage "usage interne" réservée par GS1 (préfixe
// 20-29) — jamais en collision avec un vrai code-barres commercial, tout en
// restant un code scannable standard. Idempotent : si la variante a déjà un
// code-barres, il est retourné tel quel.
export async function ensureVariantBarcode(db: Database, variantId: number): Promise<string> {
  const variant = await db
    .select()
    .from(schema.productVariants)
    .where(eq(schema.productVariants.id, variantId))
    .get();
  if (!variant) {
    throw new Error(t("coreErrors.products.variantNotFound"));
  }
  if (variant.barcode) return variant.barcode;

  const digits12 = `20${String(variantId).padStart(10, "0")}`;
  const barcode = `${digits12}${ean13CheckDigit(digits12)}`;

  await db
    .update(schema.productVariants)
    .set({ barcode })
    .where(eq(schema.productVariants.id, variantId))
    .run();

  return barcode;
}
