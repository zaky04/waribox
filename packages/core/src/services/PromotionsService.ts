import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { desc, eq } from "drizzle-orm";
import { requirePermission, type PermissionSet } from "../domain/permissions";

export type PromotionScope = "product" | "invoice";

export interface CreatePromotionInput {
  name: string;
  scope: PromotionScope;
  discountPercent: number;
  startDate: string; // "YYYY-MM-DD"
  endDate: string; // "YYYY-MM-DD"
  // Requis et non vide si scope === "product" — ignoré si scope === "invoice"
  // (une remise facture n'a pas de liste de produits, elle porte sur tout).
  productIds?: number[];
}

function validatePromotionInput(input: CreatePromotionInput) {
  if (!input.name.trim()) throw new Error(t("coreErrors.promotions.nameRequired"));
  if (!(input.discountPercent > 0 && input.discountPercent <= 100)) {
    throw new Error(t("coreErrors.promotions.percentRange"));
  }
  if (input.startDate > input.endDate) {
    throw new Error(t("coreErrors.promotions.dateOrder"));
  }
  if (input.scope === "product" && (!input.productIds || input.productIds.length === 0)) {
    throw new Error(t("coreErrors.promotions.productsRequired"));
  }
}

export async function createPromotion(db: Database, input: CreatePromotionInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_promotions");
  validatePromotionInput(input);

  const promotion = await db
    .insert(schema.promotions)
    .values({
      name: input.name.trim(),
      scope: input.scope,
      discountPercent: input.discountPercent,
      startDate: input.startDate,
      endDate: input.endDate,
    })
    .returning()
    .get();

  if (input.scope === "product") {
    for (const productId of input.productIds ?? []) {
      await db.insert(schema.promotionProducts).values({ promotionId: promotion.id, productId });
    }
  }

  return promotion;
}

export interface UpdatePromotionInput {
  name?: string;
  discountPercent?: number;
  startDate?: string;
  endDate?: string;
  isActive?: boolean;
  // Fourni uniquement pour une promotion scope="product" — remplace
  // intégralement la liste de produits associés.
  productIds?: number[];
}

export async function updatePromotion(
  db: Database,
  id: number,
  input: UpdatePromotionInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_promotions");

  const existing = await db.select().from(schema.promotions).where(eq(schema.promotions.id, id)).get();
  if (!existing) throw new Error(t("coreErrors.promotions.notFound"));

  if (input.discountPercent !== undefined && !(input.discountPercent > 0 && input.discountPercent <= 100)) {
    throw new Error(t("coreErrors.promotions.percentRange"));
  }
  const startDate = input.startDate ?? existing.startDate;
  const endDate = input.endDate ?? existing.endDate;
  if (startDate > endDate) {
    throw new Error(t("coreErrors.promotions.dateOrder"));
  }

  const updated = await db
    .update(schema.promotions)
    .set({
      name: input.name?.trim(),
      discountPercent: input.discountPercent,
      startDate: input.startDate,
      endDate: input.endDate,
      isActive: input.isActive,
    })
    .where(eq(schema.promotions.id, id))
    .returning()
    .get();

  if (existing.scope === "product" && input.productIds) {
    await db.delete(schema.promotionProducts).where(eq(schema.promotionProducts.promotionId, id));
    for (const productId of input.productIds) {
      await db.insert(schema.promotionProducts).values({ promotionId: id, productId });
    }
  }

  return updated;
}

export async function deletePromotion(db: Database, id: number, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_promotions");
  await db.delete(schema.promotionProducts).where(eq(schema.promotionProducts.promotionId, id));
  await db.delete(schema.promotions).where(eq(schema.promotions.id, id));
}

export async function listPromotions(db: Database) {
  return db.select().from(schema.promotions).orderBy(desc(schema.promotions.id));
}

export async function listPromotionProducts(db: Database, promotionId: number) {
  return db
    .select()
    .from(schema.promotionProducts)
    .where(eq(schema.promotionProducts.promotionId, promotionId));
}

export function isPromotionActiveOn(
  promotion: { isActive: boolean; startDate: string; endDate: string },
  date: string,
): boolean {
  return promotion.isActive && promotion.startDate <= date && date <= promotion.endDate;
}

export interface ActiveProductDiscount {
  promotionId: number;
  promotionName: string;
  discountPercent: number;
}

// Remise produit active la plus avantageuse par produit — si deux
// promotions "produit" actives se chevauchent sur le même article
// (chose rare mais possible), on retient le taux le plus élevé plutôt que
// de les cumuler, pour rester prévisible et éviter une remise > 100%.
export async function getActiveProductDiscounts(
  db: Database,
  date: string = new Date().toISOString().slice(0, 10),
): Promise<Map<number, ActiveProductDiscount>> {
  const [promos, links] = await Promise.all([
    listPromotions(db),
    db.select().from(schema.promotionProducts),
  ]);

  const activeProductPromos = promos.filter((p) => p.scope === "product" && isPromotionActiveOn(p, date));
  const result = new Map<number, ActiveProductDiscount>();

  for (const promo of activeProductPromos) {
    for (const link of links.filter((l) => l.promotionId === promo.id)) {
      const existing = result.get(link.productId);
      if (!existing || promo.discountPercent > existing.discountPercent) {
        result.set(link.productId, {
          promotionId: promo.id,
          promotionName: promo.name,
          discountPercent: promo.discountPercent,
        });
      }
    }
  }

  return result;
}

// Une seule remise facture peut s'appliquer à la fois — si plusieurs sont
// actives simultanément, on retient la plus avantageuse (même convention
// que pour les remises produit) plutôt que de les cumuler.
export async function getActiveInvoicePromotion(
  db: Database,
  date: string = new Date().toISOString().slice(0, 10),
) {
  const promos = await listPromotions(db);
  const activeInvoicePromos = promos.filter((p) => p.scope === "invoice" && isPromotionActiveOn(p, date));
  if (activeInvoicePromos.length === 0) return null;
  return activeInvoicePromos.reduce((best, p) => (p.discountPercent > best.discountPercent ? p : best));
}

export interface ActivePromotionWithProducts {
  id: number;
  name: string;
  scope: PromotionScope;
  discountPercent: number;
  startDate: string;
  endDate: string;
  // Renseigné uniquement pour scope === "product" — vide pour "invoice".
  productIds: number[];
}

// Promotions actuellement en cours (dates + isActive), avec leurs produits
// associés — utilisé pour afficher la liste à cocher au comptoir (Ventes),
// plutôt que de les appliquer silencieusement comme le fait
// getActiveProductDiscounts/getActiveInvoicePromotion (toujours utiles pour
// d'autres besoins, ex: un futur rapport).
export async function getActivePromotionsWithProducts(
  db: Database,
  date: string = new Date().toISOString().slice(0, 10),
): Promise<ActivePromotionWithProducts[]> {
  const [promos, links] = await Promise.all([
    listPromotions(db),
    db.select().from(schema.promotionProducts),
  ]);
  const active = promos.filter((p) => isPromotionActiveOn(p, date));
  return active.map((p) => ({
    id: p.id,
    name: p.name,
    scope: p.scope as PromotionScope,
    discountPercent: p.discountPercent,
    startDate: p.startDate,
    endDate: p.endDate,
    productIds: p.scope === "product" ? links.filter((l) => l.promotionId === p.id).map((l) => l.productId) : [],
  }));
}
