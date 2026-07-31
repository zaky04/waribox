import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { DEFAULT_LOCATIONS, type DefaultLocationKey } from "../domain/stock";

// Idempotent : crée les emplacements par défaut (Réserve / Surface de vente)
// s'ils n'existent pas encore, puis retourne leurs ids.
export async function ensureDefaultLocations(db: Database): Promise<Record<DefaultLocationKey, number>> {
  const result = {} as Record<DefaultLocationKey, number>;

  for (const key of Object.keys(DEFAULT_LOCATIONS) as DefaultLocationKey[]) {
    const location = DEFAULT_LOCATIONS[key];
    const existing = await db
      .select()
      .from(schema.stockLocations)
      .where(eq(schema.stockLocations.type, location.type))
      .get();

    if (existing) {
      result[key] = existing.id;
      continue;
    }

    const created = await db
      .insert(schema.stockLocations)
      .values({ name: location.name, type: location.type })
      .returning()
      .get();

    result[key] = created.id;
  }

  return result;
}

export async function listLocations(db: Database) {
  return db.select().from(schema.stockLocations);
}

export interface RecordMovementInput {
  variantId: number;
  locationId: number;
  quantityDelta: number;
  movementType: "purchase" | "sale" | "transfer" | "adjustment" | "loss";
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

export async function transferStock(db: Database, input: TransferStockInput) {
  await recordMovement(db, {
    variantId: input.variantId,
    locationId: input.fromLocationId,
    quantityDelta: -input.quantity,
    movementType: "transfer",
    userId: input.userId,
  });
  await recordMovement(db, {
    variantId: input.variantId,
    locationId: input.toLocationId,
    quantityDelta: input.quantity,
    movementType: "transfer",
    userId: input.userId,
  });
}

export interface StockLevel {
  variantId: number;
  locationId: number;
  quantity: number;
}

// Le solde n'est jamais stocké : il se calcule à partir du grand livre des
// mouvements (SUM des deltas), comme en comptabilité.
export async function getStockLevels(db: Database): Promise<StockLevel[]> {
  const rows = await db
    .select({
      variantId: schema.stockMovements.variantId,
      locationId: schema.stockMovements.locationId,
      quantity: sql<number>`SUM(${schema.stockMovements.quantityDelta})`,
    })
    .from(schema.stockMovements)
    .groupBy(schema.stockMovements.variantId, schema.stockMovements.locationId);

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

export async function getLowStockProducts(db: Database): Promise<LowStockEntry[]> {
  const [products, variants, levels] = await Promise.all([
    db.select().from(schema.products),
    db.select().from(schema.productVariants),
    getStockLevels(db),
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
  expiryDate: string;
  quantity: number;
}

export async function createBatch(db: Database, input: CreateBatchInput) {
  return db.insert(schema.stockBatches).values(input).returning().get();
}

export interface ExpiringBatch {
  batch: typeof schema.stockBatches.$inferSelect;
  variant: typeof schema.productVariants.$inferSelect;
}

export async function listExpiringBatches(db: Database, withinDays: number): Promise<ExpiringBatch[]> {
  const [batches, variants] = await Promise.all([
    db.select().from(schema.stockBatches),
    db.select().from(schema.productVariants),
  ]);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + withinDays);

  const result: ExpiringBatch[] = [];
  for (const batch of batches) {
    if (!batch.expiryDate || new Date(batch.expiryDate) > cutoff) continue;
    const variant = variants.find((v) => v.id === batch.variantId);
    if (variant) result.push({ batch, variant });
  }
  return result;
}
