import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { eq } from "drizzle-orm";
import { logAction } from "./AuditService";
import { requireApproval, type ApprovalInput } from "./ApprovalService";
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

// Crée les catégories proposées d'un secteur (ex. pharmacie) qui n'existent pas
// encore — comparaison sans casse ni espaces superflus, donc relancer l'action ne
// crée jamais de doublon. Retourne les noms réellement créés.
export async function installStarterCategories(
  db: Database,
  names: string[],
  userId: number | undefined,
  actingPermissions: PermissionSet,
): Promise<string[]> {
  requirePermission(actingPermissions, "manage_products");
  const existing = new Set((await listCategories(db)).map((c) => c.name.trim().toLowerCase()));
  const created: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || existing.has(name.toLowerCase())) continue;
    await createCategory(db, { name, createdBy: userId }, actingPermissions);
    existing.add(name.toLowerCase());
    created.push(name);
  }
  return created;
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
  // Fiche médicament (pack Pharmacie) — tous facultatifs.
  dci?: string | null;
  dosage?: string | null;
  dosageForm?: string | null;
  laboratory?: string | null;
  requiresPrescription?: boolean;
}

// Texte facultatif : vide ou espaces → NULL (jamais une chaîne vide en base).
function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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
      dci: cleanText(input.dci),
      dosage: cleanText(input.dosage),
      dosageForm: cleanText(input.dosageForm),
      laboratory: cleanText(input.laboratory),
      requiresPrescription: input.requiresPrescription ?? false,
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
  approval?: ApprovalInput;
  dci?: string | null;
  dosage?: string | null;
  dosageForm?: string | null;
  laboratory?: string | null;
  requiresPrescription?: boolean;
}

export async function updateProduct(
  db: Database,
  productId: number,
  input: UpdateProductInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_products");
  const before = await db.select().from(schema.products).where(eq(schema.products.id, productId)).get();
  // Changer un prix (vente ou achat) : droit dédié et, au-delà du seuil, approbation.
  let priceApprovedBy: number | null = null;
  const saleDelta = input.salePrice !== undefined && before ? Math.abs(input.salePrice - before.salePrice) : 0;
  const purchaseDelta = input.purchasePrice !== undefined && before ? Math.abs(input.purchasePrice - before.purchasePrice) : 0;
  const priceDelta = Math.max(saleDelta, purchaseDelta);
  if (priceDelta > 0.001) {
    requirePermission(actingPermissions, "edit_product_prices");
    priceApprovedBy = await requireApproval(db, { kind: "price", amount: priceDelta, userId: input.updatedBy, actingPermissions, approval: input.approval });
  }
  const updates: Partial<typeof schema.products.$inferInsert> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.categoryId !== undefined) updates.categoryId = input.categoryId;
  if (input.unit !== undefined) updates.unit = input.unit;
  if (input.purchasePrice !== undefined) updates.purchasePrice = input.purchasePrice;
  if (input.salePrice !== undefined) updates.salePrice = input.salePrice;
  if (input.taxRate !== undefined) updates.taxRate = input.taxRate;
  if (input.lowStockThreshold !== undefined) updates.lowStockThreshold = input.lowStockThreshold;
  if (input.trackExpiry !== undefined) updates.trackExpiry = input.trackExpiry;
  if (input.dci !== undefined) updates.dci = cleanText(input.dci);
  if (input.dosage !== undefined) updates.dosage = cleanText(input.dosage);
  if (input.dosageForm !== undefined) updates.dosageForm = cleanText(input.dosageForm);
  if (input.laboratory !== undefined) updates.laboratory = cleanText(input.laboratory);
  if (input.requiresPrescription !== undefined) updates.requiresPrescription = input.requiresPrescription;

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
      // Uniquement les champs réellement modifiés, avec l'ancienne ET la nouvelle
      // valeur : un changement de prix silencieux est un classique de fraude.
      metadata: {
        name: updated.name,
        salePrice: updated.salePrice,
        ...(priceApprovedBy != null ? { approvedBy: priceApprovedBy } : {}),
        changes: diffFields(before, updated, ["name", "categoryId", "unit", "purchasePrice", "salePrice", "taxRate", "lowStockThreshold", "trackExpiry", "dci", "dosage", "dosageForm", "laboratory", "requiresPrescription"]),
      },
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
  // Présentation conditionnée (ex. « plaquette » contenue dans une « boîte ») :
  // variante parente du MÊME produit et nombre d'unités qu'elle contient.
  parentVariantId?: number;
  unitsPerParent?: number;
}

export async function createVariant(db: Database, input: VariantInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_products");
  if (input.parentVariantId != null || input.unitsPerParent != null) {
    if (input.parentVariantId == null || !(input.unitsPerParent! > 0)) {
      throw new Error(t("coreErrors.pharmacy.packInvalid"));
    }
    const parent = await db
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, input.parentVariantId))
      .get();
    // Même produit, et un seul niveau (une boîte contient des plaquettes, une
    // plaquette ne contient rien) : pas de chaîne, donc pas de cycle possible.
    if (!parent || parent.productId !== input.productId || parent.parentVariantId != null) {
      throw new Error(t("coreErrors.pharmacy.packInvalid"));
    }
  }
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
      parentVariantId: input.parentVariantId ?? null,
      unitsPerParent: input.unitsPerParent ?? null,
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

// Champs qui diffèrent entre deux états d'une ligne : { champ: { from, to } }.
export function diffFields<T extends Record<string, unknown>>(
  before: T | undefined,
  after: T,
  fields: (keyof T & string)[],
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    if (before && before[f] !== after[f]) out[f] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  return out;
}
