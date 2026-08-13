import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { DEFAULT_LOCATIONS, type DefaultLocationKey } from "../domain/stock";
import { requirePermission, type PermissionSet } from "../domain/permissions";

// Idempotent : crée les emplacements par défaut (Réserve / Surface de vente)
// d'une boutique s'ils n'existent pas encore, puis retourne leurs ids. Le
// type ('reserve'/'surface_vente') reste globalement unique en base
// (contrainte historique, antérieure au multi-boutique) — la première
// boutique à réclamer un type le garde tel quel (rétrocompatibilité totale
// avec les bases mono-boutique existantes), toute boutique suivante reçoit un
// type suffixé par son id.
export async function ensureLocationsForStore(
  db: Database,
  storeId: number,
): Promise<Record<DefaultLocationKey, number>> {
  const result = {} as Record<DefaultLocationKey, number>;

  for (const key of Object.keys(DEFAULT_LOCATIONS) as DefaultLocationKey[]) {
    const location = DEFAULT_LOCATIONS[key];

    const existingForStore = await db
      .select()
      .from(schema.stockLocations)
      .where(and(eq(schema.stockLocations.storeId, storeId), eq(schema.stockLocations.type, location.type)))
      .get();
    if (existingForStore) {
      result[key] = existingForStore.id;
      continue;
    }

    const typeConflict = await db
      .select()
      .from(schema.stockLocations)
      .where(eq(schema.stockLocations.type, location.type))
      .get();
    const typeValue = typeConflict ? `${location.type}#${storeId}` : location.type;

    const created = await db
      .insert(schema.stockLocations)
      .values({ name: location.name, type: typeValue, storeId })
      .returning()
      .get();

    result[key] = created.id;
  }

  return result;
}

export async function listLocations(db: Database, storeId?: number) {
  const query = db.select().from(schema.stockLocations);
  return storeId ? query.where(eq(schema.stockLocations.storeId, storeId)) : query;
}

export interface RecordMovementInput {
  variantId: number;
  locationId: number;
  quantityDelta: number;
  movementType: "purchase" | "sale" | "transfer" | "adjustment" | "loss" | "return";
  referenceType?: string;
  referenceId?: number;
  batchId?: number;
  userId?: number;
}

export async function recordMovement(db: Database, input: RecordMovementInput) {
  return db
    .insert(schema.stockMovements)
    .values({
      variantId: input.variantId,
      locationId: input.locationId,
      quantityDelta: input.quantityDelta,
      movementType: input.movementType,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      batchId: input.batchId,
      createdBy: input.userId,
    })
    .returning()
    .get();
}

export interface StockMovementFilters {
  from?: string; // "YYYY-MM-DD"
  to?: string;
  userId?: number;
  movementType?: string;
  locationId?: number;
}

// Le grand livre des mouvements sert lui-même de journal de sortie/entrée de
// stock — inutile de dupliquer ces événements dans audit_log.
export async function listStockMovements(db: Database, filters: StockMovementFilters = {}) {
  const conditions = [];
  if (filters.from) conditions.push(gte(schema.stockMovements.createdAt, `${filters.from.slice(0, 10)} 00:00:00`));
  if (filters.to) conditions.push(lte(schema.stockMovements.createdAt, `${filters.to.slice(0, 10)} 23:59:59`));
  if (filters.userId) conditions.push(eq(schema.stockMovements.createdBy, filters.userId));
  if (filters.movementType) conditions.push(eq(schema.stockMovements.movementType, filters.movementType));
  if (filters.locationId) conditions.push(eq(schema.stockMovements.locationId, filters.locationId));

  const query = db.select().from(schema.stockMovements).orderBy(desc(schema.stockMovements.id));
  return conditions.length > 0 ? query.where(and(...conditions)) : query;
}

export interface TransferStockInput {
  variantId: number;
  fromLocationId: number;
  toLocationId: number;
  quantity: number;
  userId?: number;
}

// Un transfert doit conserver la traçabilité par lot (coût, péremption) —
// sans ça, le stock qui passe de la Réserve à la Surface de vente perdrait
// son lot d'origine et retomberait dans le "reliquat sans lot" de
// consumeStockFefo, ce qui fausserait le calcul de marge réel dès qu'un
// achat suit le flux normal Achat → Réserve → Transfert → Vente (voir le
// commentaire sur getCostOfGoodsSoldBySaleAndVariant dans ReportsService).
// Même ordre FEFO que consumeStockFefo pour décider quel(s) lot(s) source
// sont consommés en premier ; chaque lot source consommé se prolonge par un
// lot "miroir" au même coût/péremption à l'emplacement de destination.
export async function transferStock(
  db: Database,
  input: TransferStockInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_stock");
  const batches = await db
    .select()
    .from(schema.stockBatches)
    .where(
      and(
        eq(schema.stockBatches.variantId, input.variantId),
        eq(schema.stockBatches.locationId, input.fromLocationId),
      ),
    );
  const remainingMap = await getBatchRemainingMap(db, batches.map((b) => b.id));
  const withRemaining = batches
    .map((batch) => ({ batch, remaining: remainingMap.get(batch.id) ?? 0 }))
    .filter((b) => b.remaining > 0)
    .sort((a, b) => {
      if (!a.batch.expiryDate && !b.batch.expiryDate) return a.batch.id - b.batch.id;
      if (!a.batch.expiryDate) return 1;
      if (!b.batch.expiryDate) return -1;
      return a.batch.expiryDate.localeCompare(b.batch.expiryDate);
    });

  let toTransfer = input.quantity;
  for (const { batch, remaining } of withRemaining) {
    if (toTransfer <= 0) break;
    const take = Math.min(toTransfer, remaining);
    if (take <= 0) continue;

    await recordMovement(db, {
      variantId: input.variantId,
      locationId: input.fromLocationId,
      quantityDelta: -take,
      movementType: "transfer",
      batchId: batch.id,
      userId: input.userId,
    });

    // Nouveau lot par transfert plutôt que de chercher à en réutiliser un
    // existant à destination — reste simple, et le nombre de lots créés
    // demeure proportionnel aux mouvements réels.
    const destBatch = await createBatch(db, {
      variantId: input.variantId,
      locationId: input.toLocationId,
      lotNumber: batch.lotNumber ?? undefined,
      expiryDate: batch.expiryDate ?? undefined,
      quantity: take,
      unitCost: batch.unitCost ?? undefined,
    });

    await recordMovement(db, {
      variantId: input.variantId,
      locationId: input.toLocationId,
      quantityDelta: take,
      movementType: "transfer",
      batchId: destBatch.id,
      userId: input.userId,
    });

    toTransfer -= take;
  }

  // Reliquat sans lot (produit non suivi par lot, ou lots insuffisants) —
  // comme avant l'introduction du suivi par lot, aucune rupture de
  // compatibilité pour les produits qui n'en ont jamais eu.
  if (toTransfer > 0) {
    await recordMovement(db, {
      variantId: input.variantId,
      locationId: input.fromLocationId,
      quantityDelta: -toTransfer,
      movementType: "transfer",
      userId: input.userId,
    });
    await recordMovement(db, {
      variantId: input.variantId,
      locationId: input.toLocationId,
      quantityDelta: toTransfer,
      movementType: "transfer",
      userId: input.userId,
    });
  }
}

export interface StockLevel {
  variantId: number;
  locationId: number;
  quantity: number;
}

// Emplacements appartenant à une boutique donnée — utilisé pour scoper les
// fonctions ci-dessous par boutique quand le multi-boutique est activé.
async function locationIdsForStore(db: Database, storeId: number): Promise<number[]> {
  const rows = await db
    .select({ id: schema.stockLocations.id })
    .from(schema.stockLocations)
    .where(eq(schema.stockLocations.storeId, storeId));
  return rows.map((r) => r.id);
}

// Le solde n'est jamais stocké : il se calcule à partir du grand livre des
// mouvements (SUM des deltas), comme en comptabilité. `storeId` restreint le
// calcul aux emplacements de cette boutique (mono-boutique = tous, storeId
// omis).
export async function getStockLevels(db: Database, storeId?: number): Promise<StockLevel[]> {
  const query = db
    .select({
      variantId: schema.stockMovements.variantId,
      locationId: schema.stockMovements.locationId,
      quantity: sql<number>`SUM(${schema.stockMovements.quantityDelta})`,
    })
    .from(schema.stockMovements)
    .groupBy(schema.stockMovements.variantId, schema.stockMovements.locationId);

  const rows = storeId
    ? await query.where(inArray(schema.stockMovements.locationId, await locationIdsForStore(db, storeId)))
    : await query;

  return rows.map((r) => ({
    variantId: r.variantId,
    locationId: r.locationId,
    quantity: Number(r.quantity),
  }));
}

export interface LowStockEntry {
  product: typeof schema.products.$inferSelect;
  variantId: number;
  totalStock: number;
}

export async function getLowStockProducts(db: Database, storeId?: number): Promise<LowStockEntry[]> {
  const [products, variants, levels] = await Promise.all([
    db.select().from(schema.products),
    db.select().from(schema.productVariants),
    getStockLevels(db, storeId),
  ]);

  const stockByVariant = new Map<number, number>();
  for (const level of levels) {
    stockByVariant.set(level.variantId, (stockByVariant.get(level.variantId) ?? 0) + level.quantity);
  }

  const result: LowStockEntry[] = [];
  for (const product of products) {
    const productVariants = variants.filter((v) => v.productId === product.id);
    const totalStock = productVariants.reduce((sum, v) => sum + (stockByVariant.get(v.id) ?? 0), 0);
    if (totalStock <= product.lowStockThreshold) {
      result.push({ product, variantId: productVariants[0]?.id ?? 0, totalStock });
    }
  }
  return result;
}

export interface CreateBatchInput {
  variantId: number;
  locationId: number;
  lotNumber?: string;
  expiryDate?: string;
  quantity: number;
  // Coût d'achat unitaire de ce lot — renseigné par PurchasesService, absent
  // pour une entrée de stock manuelle (voir le commentaire sur la colonne
  // dans schema/stock.ts).
  unitCost?: number;
}

export async function createBatch(db: Database, input: CreateBatchInput) {
  return db.insert(schema.stockBatches).values(input).returning().get();
}

export interface ManualStockEntryInput {
  variantId: number;
  locationId: number;
  quantity: number;
  lotNumber?: string;
  expiryDate?: string;
  userId?: number;
}

// Entrée de stock manuelle (StockPage) — distincte des mouvements internes
// (achat, vente, transfert, remboursement), qui portent chacun leur propre
// permission via leur flux d'origine et appellent directement createBatch/
// recordMovement (primitives volontairement non gardées, car partagées par
// ces flux). Celle-ci est le seul point d'entrée de saisie manuelle, donc
// gardée elle-même.
export async function addManualStockEntry(
  db: Database,
  input: ManualStockEntryInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_stock");

  let batchId: number | undefined;
  if (input.expiryDate) {
    const batch = await createBatch(db, {
      variantId: input.variantId,
      locationId: input.locationId,
      lotNumber: input.lotNumber,
      expiryDate: input.expiryDate,
      quantity: input.quantity,
    });
    batchId = batch.id;
  }

  await recordMovement(db, {
    variantId: input.variantId,
    locationId: input.locationId,
    quantityDelta: input.quantity,
    movementType: "adjustment",
    referenceType: "manual",
    batchId,
    userId: input.userId,
  });
}

export interface RecordStockLossInput {
  variantId: number;
  locationId: number;
  quantity: number;
  reason: string;
  userId?: number;
}

// Retrait pour perte/péremption/casse/vol (StockPage) — même raisonnement
// que addManualStockEntry ci-dessus.
export async function recordStockLoss(
  db: Database,
  input: RecordStockLossInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_stock");
  await recordMovement(db, {
    variantId: input.variantId,
    locationId: input.locationId,
    quantityDelta: -input.quantity,
    movementType: "loss",
    referenceType: input.reason,
    userId: input.userId,
  });
}

// Utilisé par Journaux pour afficher le numéro de lot d'un mouvement de
// stock (mouvement.batchId → lot.lotNumber) — simple lecture, pas de
// recalcul de solde ici (voir getBatchRemainingMap pour ça).
export async function listBatches(db: Database) {
  return db.select().from(schema.stockBatches);
}

// Solde restant par lot — même principe que getStockLevels (jamais stocké,
// toujours recalculé depuis le grand livre), mais groupé par batchId au lieu
// de variantId+locationId. Alimenté par consumeStockFefo (ventes) et par
// RefundsService (retours), qui taguent chacun de leurs mouvements avec le
// bon batchId — voir ces deux fonctions.
export async function getBatchRemainingMap(db: Database, batchIds: number[]): Promise<Map<number, number>> {
  if (batchIds.length === 0) return new Map();
  const rows = await db
    .select({
      batchId: schema.stockMovements.batchId,
      quantity: sql<number>`SUM(${schema.stockMovements.quantityDelta})`,
    })
    .from(schema.stockMovements)
    .where(inArray(schema.stockMovements.batchId, batchIds))
    .groupBy(schema.stockMovements.batchId);

  const map = new Map<number, number>();
  for (const row of rows) {
    if (row.batchId != null) map.set(row.batchId, Number(row.quantity));
  }
  return map;
}

export interface ConsumeStockInput {
  variantId: number;
  locationId: number;
  quantity: number;
  movementType: "sale";
  referenceType?: string;
  referenceId?: number;
  userId?: number;
}

// Décrémente le stock en respectant l'ordre FEFO (premier expiré, premier
// sorti) parmi les lots existants pour ce produit+emplacement — chaque
// mouvement de sortie est tagué avec le batchId exact d'où il provient,
// permettant une traçabilité vente/remboursement ↔ lot précis (voir
// RefundsService.createRefund pour la réattribution au remboursement). Le
// reliquat éventuel (produit non suivi en péremption, ou lots insuffisants)
// part sans batchId, comme avant l'introduction du suivi par lot — aucune
// rupture de compatibilité pour les produits sans lot.
export async function consumeStockFefo(db: Database, input: ConsumeStockInput): Promise<void> {
  const batches = await db
    .select()
    .from(schema.stockBatches)
    .where(
      and(eq(schema.stockBatches.variantId, input.variantId), eq(schema.stockBatches.locationId, input.locationId)),
    );

  const remainingMap = await getBatchRemainingMap(db, batches.map((b) => b.id));
  const withRemaining = batches
    .map((batch) => ({ batch, remaining: remainingMap.get(batch.id) ?? 0 }))
    .filter((b) => b.remaining > 0)
    .sort((a, b) => {
      if (!a.batch.expiryDate && !b.batch.expiryDate) return a.batch.id - b.batch.id;
      if (!a.batch.expiryDate) return 1;
      if (!b.batch.expiryDate) return -1;
      return a.batch.expiryDate.localeCompare(b.batch.expiryDate);
    });

  let toConsume = input.quantity;
  for (const { batch, remaining } of withRemaining) {
    if (toConsume <= 0) break;
    const take = Math.min(toConsume, remaining);
    if (take <= 0) continue;
    await recordMovement(db, {
      variantId: input.variantId,
      locationId: input.locationId,
      quantityDelta: -take,
      movementType: input.movementType,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      batchId: batch.id,
      userId: input.userId,
    });
    toConsume -= take;
  }

  if (toConsume > 0) {
    await recordMovement(db, {
      variantId: input.variantId,
      locationId: input.locationId,
      quantityDelta: -toConsume,
      movementType: input.movementType,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      userId: input.userId,
    });
  }
}

export interface ExpiringBatch {
  batch: typeof schema.stockBatches.$inferSelect;
  variant: typeof schema.productVariants.$inferSelect;
}

export async function listExpiringBatches(
  db: Database,
  withinDays: number,
  storeId?: number,
): Promise<ExpiringBatch[]> {
  const [allBatches, variants, storeLocationIds] = await Promise.all([
    db.select().from(schema.stockBatches),
    db.select().from(schema.productVariants),
    storeId ? locationIdsForStore(db, storeId) : Promise.resolve<number[] | null>(null),
  ]);
  const batches = storeLocationIds
    ? allBatches.filter((b) => storeLocationIds.includes(b.locationId))
    : allBatches;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + withinDays);
  const candidateBatches = batches.filter((b) => b.expiryDate && new Date(b.expiryDate) <= cutoff);

  // Précis par lot (et non plus au niveau du produit) maintenant que les
  // ventes/remboursements taguent chaque mouvement avec le bon batchId (voir
  // consumeStockFefo) — un lot épuisé disparaît de l'alerte même si d'autres
  // lots du même produit ont encore du stock.
  const remainingMap = await getBatchRemainingMap(db, candidateBatches.map((b) => b.id));

  const result: ExpiringBatch[] = [];
  for (const batch of candidateBatches) {
    if ((remainingMap.get(batch.id) ?? 0) <= 0) continue;
    const variant = variants.find((v) => v.id === batch.variantId);
    if (variant) result.push({ batch, variant });
  }
  return result;
}
