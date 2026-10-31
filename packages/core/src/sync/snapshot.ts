import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq, inArray, sql } from "drizzle-orm";
import { REMOTE_PIN_HASH } from "../auth/pin";
import { DEVICE_LOCAL_SETTINGS } from "../domain/relayGuard";
import { getCatalogHashes, setCatalogHashes } from "./syncStore";

// État que le Maître transmet à un appareil relié — voir CLAUDE.md, mode réseau.
//
// Le Maître FAIT FOI pour le catalogue (produits, prix, utilisateurs, réglages, clients...) et pour
// le niveau de stock. Un appareil relié ne le modifie pas (voir catalogGuard.ts) ; il le reçoit :
//  - en entier à la toute première connexion ;
//  - ensuite par rafraîchissements : seules les tables dont l'empreinte a changé sont renvoyées.
//
// Deux familles de tables :
//  - tables « d'identifiants du Maître » (produits, variantes, utilisateurs, rôles, boutiques,
//    emplacements, catégories, fournisseurs, réglages) : seul le Maître y écrit, les identifiants
//    locaux sont recopiés tels quels et la table est remplacée en bloc ;
//  - tables « fusionnées par syncId » (clients, lots) : un appareil relié en crée aussi (client de
//    passage saisi à la caisse, lot d'une entrée de stock), avec ses propres identifiants locaux.
//    On les fusionne par identité universelle (sync_id) sans jamais toucher aux identifiants
//    locaux déjà référencés par ses ventes.
//
// Le stock n'est jamais « copié » : il se déduit des mouvements. Pour que l'appareil relié voie le
// même niveau que le Maître (achats, remboursements, inventaires faits sur le Maître, historique
// d'avant l'appairage), le Maître envoie ses soldes et l'appareil enregistre des mouvements de
// correction (« rebase ») pour combler l'écart — son historique reste intact.
export interface StockBalance {
  variantId: number;
  locationId: number;
  /** Identité universelle du lot (jamais l'identifiant local), ou null si le mouvement n'a pas de lot. */
  batchSyncId: string | null;
  quantity: number;
}

export interface CatalogSnapshot {
  categories?: Array<typeof schema.categories.$inferSelect>;
  products?: Array<typeof schema.products.$inferSelect>;
  productVariants?: Array<typeof schema.productVariants.$inferSelect>;
  stores?: Array<typeof schema.stores.$inferSelect>;
  stockLocations?: Array<typeof schema.stockLocations.$inferSelect>;
  suppliers?: Array<typeof schema.suppliers.$inferSelect>;
  roles?: Array<typeof schema.roles.$inferSelect>;
  users?: Array<typeof schema.users.$inferSelect>;
  /** Fusionnés par syncId. */
  customers?: Array<typeof schema.customers.$inferSelect>;
  stockBatches?: Array<typeof schema.stockBatches.$inferSelect>;
  // Demandes d'approbation encore en attente au moment du premier appairage : un téléphone
  // de propriétaire qui rejoint le réseau doit voir ce qui attend sa décision.
  approvalRequests?: Array<typeof schema.approvalRequests.$inferSelect>;
  // Le code de maintenance protège une action desktop-only (installer une mise à jour) sans
  // rapport avec ce qu'un appareil relié a besoin de faire : il ne quitte jamais le Maître.
  // Les hash de PIN sont remplacés par un marqueur (voir buildCatalogSnapshot).
  businessSettings?: Omit<typeof schema.businessSettings.$inferSelect, "maintenanceCodeHash" | "maintenanceCodeFailedAttempts" | "maintenanceCodeLockedUntil">;
  /** Soldes de stock du Maître à `asOfSeq` — l'appareil relié s'y aligne. */
  stockBalances?: StockBalance[];
  /** Empreinte de chaque table transmise (l'appareil les garde pour ne redemander que ce qui change). */
  hashes: Record<string, string>;
}

/** Tables remplacées en bloc, dans l'ordre d'application. */
const REPLACED_TABLES = ["roles", "stores", "users", "categories", "products", "productVariants", "stockLocations", "suppliers"] as const;
const MERGED_TABLES = ["stockBatches", "customers"] as const;
type ReplacedTable = (typeof REPLACED_TABLES)[number];


async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function byIdentity<T extends { id?: number; syncId?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id ?? 0) - (b.id ?? 0) || String(a.syncId ?? "").localeCompare(String(b.syncId ?? "")));
}

export async function computeStockBalances(db: Database): Promise<StockBalance[]> {
  const grouped = await db
    .select({
      variantId: schema.stockMovements.variantId,
      locationId: schema.stockMovements.locationId,
      batchId: schema.stockMovements.batchId,
      quantity: sql<number>`sum(${schema.stockMovements.quantityDelta})`,
    })
    .from(schema.stockMovements)
    .groupBy(schema.stockMovements.variantId, schema.stockMovements.locationId, schema.stockMovements.batchId);
  const batchIds = [...new Set(grouped.map((g) => g.batchId).filter((id): id is number => id != null))];
  const syncIdByBatch = new Map<number, string | null>();
  for (let i = 0; i < batchIds.length; i += 500) {
    const rows = await db
      .select({ id: schema.stockBatches.id, syncId: schema.stockBatches.syncId })
      .from(schema.stockBatches)
      .where(inArray(schema.stockBatches.id, batchIds.slice(i, i + 500)));
    for (const r of rows) syncIdByBatch.set(r.id, r.syncId);
  }
  return grouped
    .map((g) => ({ variantId: g.variantId, locationId: g.locationId, batchSyncId: g.batchId == null ? null : (syncIdByBatch.get(g.batchId) ?? null), quantity: Number(g.quantity) }))
    .filter((b) => Math.abs(b.quantity) > 1e-9);
}

export interface BuildSnapshotOptions {
  /**
   * Empreintes que l'appareil possède déjà : les tables identiques ne sont pas renvoyées.
   * Absent = tout est envoyé (premier appairage).
   */
  knownHashes?: Record<string, string>;
  /** Premier appairage : joindre aussi les demandes d'approbation en attente. */
  includePending?: boolean;
  /** Joindre les soldes de stock (toujours au premier appairage, à chaque rafraîchissement ensuite). */
  includeStock?: boolean;
}

/** Construit l'état à transmettre — appelé côté Maître. */
export async function buildCatalogSnapshot(db: Database, options: BuildSnapshotOptions = {}): Promise<CatalogSnapshot> {
  const known = options.knownHashes ?? {};
  const settingsRows = await db.select().from(schema.businessSettings);
  const businessSettings = settingsRows[0]
    ? (() => {
        const { maintenanceCodeHash, maintenanceCodeFailedAttempts, maintenanceCodeLockedUntil, ...rest } = settingsRows[0]!;
        return rest;
      })()
    : undefined;

  const tables: Record<string, unknown[]> = {
    roles: byIdentity(await db.select().from(schema.roles)),
    stores: byIdentity(await db.select().from(schema.stores)),
    // Le hash du PIN (qui valide les approbations) ne quitte jamais le Maître : l'appareil relié reçoit
    // un marqueur et fait vérifier le PIN par le Maître (voir auth/pin.ts). Les compteurs d'essais n'ont
    // pas à être copiés non plus.
    users: byIdentity(await db.select().from(schema.users)).map((u) => ({
      ...u,
      pinHash: u.pinHash ? REMOTE_PIN_HASH : null,
      approvalPinHash: u.approvalPinHash ? REMOTE_PIN_HASH : null,
      failedAttempts: 0,
      lockedUntil: null,
      approvalFailedAttempts: 0,
      approvalLockedUntil: null,
    })),
    categories: byIdentity(await db.select().from(schema.categories)),
    products: byIdentity(await db.select().from(schema.products)),
    productVariants: byIdentity(await db.select().from(schema.productVariants)),
    stockLocations: byIdentity(await db.select().from(schema.stockLocations)),
    suppliers: byIdentity(await db.select().from(schema.suppliers)),
    stockBatches: byIdentity(await db.select().from(schema.stockBatches)),
    customers: byIdentity(await db.select().from(schema.customers)),
    businessSettings: businessSettings ? [businessSettings] : [],
  };

  const hashes: Record<string, string> = {};
  const snapshot: CatalogSnapshot = { hashes };
  for (const [name, rows] of Object.entries(tables)) {
    const hash = await sha256Hex(JSON.stringify(rows));
    hashes[name] = hash;
    if (known[name] === hash) continue; // l'appareil a déjà exactement cette version
    if (name === "businessSettings") snapshot.businessSettings = businessSettings;
    else (snapshot as unknown as Record<string, unknown>)[name] = rows;
  }
  if (options.includePending) {
    const pending = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.status, "pending"));
    snapshot.approvalRequests = pending.filter((r) => r.syncId);
  }
  if (options.includeStock) snapshot.stockBalances = await computeStockBalances(db);
  return snapshot;
}

async function replaceAll(db: Database, table: Parameters<Database["delete"]>[0], rows: Record<string, unknown>[]): Promise<void> {
  await db.delete(table).run();
  for (const row of rows) await db.insert(table).values(row).run();
}

type IdTable = { id: unknown } & Parameters<Database["delete"]>[0];

/**
 * Aligne une table « d'identifiants du Maître » sur ses lignes : mise à jour/ajout par identifiant, puis
 * suppression de ce que le Maître n'a plus. Pas de `DELETE` global suivi de réinsertions : ce serait à la
 * fois lent et refusé dès que des lignes d'autres tables y font référence.
 */
async function syncById(db: Database, table: IdTable, rows: Record<string, unknown>[]): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = table as any;
  const existing = (await db.select({ id: t.id }).from(t)) as { id: number }[];
  const incoming = new Set(rows.map((r) => r.id as number));
  const stale = existing.map((e) => e.id).filter((id) => !incoming.has(id));
  for (let i = 0; i < stale.length; i += 500) await db.delete(t).where(inArray(t.id, stale.slice(i, i + 500))).run();
  for (const row of rows) await db.insert(t).values(row).onConflictDoUpdate({ target: t.id, set: row }).run();
}

const TABLE_OBJECTS: Record<ReplacedTable, Parameters<Database["delete"]>[0]> = {
  roles: schema.roles,
  stores: schema.stores,
  users: schema.users,
  categories: schema.categories,
  products: schema.products,
  productVariants: schema.productVariants,
  stockLocations: schema.stockLocations,
  suppliers: schema.suppliers,
};

/** Clients : fusion par syncId. Les identifiants locaux déjà utilisés par les ventes de l'appareil ne changent pas. */
async function mergeCustomers(db: Database, rows: Array<typeof schema.customers.$inferSelect>): Promise<void> {
  const existing = await db.select({ id: schema.customers.id, syncId: schema.customers.syncId }).from(schema.customers);
  const idBySync = new Map(existing.filter((c) => c.syncId).map((c) => [c.syncId!, c.id] as const));
  for (const { id: _id, ...row } of rows) {
    if (!row.syncId) continue; // sans identité universelle, impossible à rapprocher : ignoré (la migration 21 en donne une à tous)
    const localId = idBySync.get(row.syncId);
    if (localId != null) await db.update(schema.customers).set(row).where(eq(schema.customers.id, localId)).run();
    else await db.insert(schema.customers).values(row).run();
  }
}

/** Lots : fusion par syncId, comme les clients. */
async function mergeBatches(db: Database, rows: Array<typeof schema.stockBatches.$inferSelect>): Promise<void> {
  const existing = await db.select({ id: schema.stockBatches.id, syncId: schema.stockBatches.syncId }).from(schema.stockBatches);
  const idBySync = new Map(existing.filter((b) => b.syncId).map((b) => [b.syncId!, b.id] as const));
  for (const { id: _id, ...row } of rows) {
    if (!row.syncId) continue;
    const localId = idBySync.get(row.syncId);
    if (localId != null) await db.update(schema.stockBatches).set(row).where(eq(schema.stockBatches.id, localId)).run();
    else await db.insert(schema.stockBatches).values(row).run();
  }
}

/**
 * Alignement du stock : pour chaque (variante, emplacement, lot), un mouvement de correction égal à
 * l'écart entre le solde du Maître et le solde local. L'historique local n'est pas touché ; si tout
 * concorde déjà, rien n'est écrit. Les lots doivent déjà avoir été fusionnés.
 */
export async function rebaseStock(db: Database, masterBalances: StockBalance[]): Promise<number> {
  const local = await computeStockBalances(db);
  const key = (b: { variantId: number; locationId: number; batchSyncId: string | null }) => `${b.variantId}:${b.locationId}:${b.batchSyncId ?? ""}`;
  const localByKey = new Map(local.map((b) => [key(b), b.quantity] as const));
  const masterKeys = new Set(masterBalances.map(key));
  const wanted: StockBalance[] = [
    ...masterBalances.map((b) => ({ ...b, quantity: b.quantity - (localByKey.get(key(b)) ?? 0) })),
    ...local.filter((b) => !masterKeys.has(key(b))).map((b) => ({ ...b, quantity: -b.quantity })),
  ].filter((d) => Math.abs(d.quantity) > 1e-9);
  if (wanted.length === 0) return 0;

  const batches = await db.select({ id: schema.stockBatches.id, syncId: schema.stockBatches.syncId }).from(schema.stockBatches);
  const batchIdBySync = new Map(batches.filter((b) => b.syncId).map((b) => [b.syncId!, b.id] as const));
  for (const d of wanted) {
    if (d.batchSyncId != null && !batchIdBySync.has(d.batchSyncId)) continue; // lot inconnu ici : sera aligné au prochain tour
    await db
      .insert(schema.stockMovements)
      .values({
        variantId: d.variantId,
        locationId: d.locationId,
        batchId: d.batchSyncId == null ? null : batchIdBySync.get(d.batchSyncId)!,
        quantityDelta: d.quantity,
        movementType: "rebase",
        referenceType: "snapshot",
        note: null,
      })
      .run();
  }
  return wanted.length;
}

/**
 * Applique l'état reçu à la base locale — côté appareil relié, dans une transaction ouverte par l'appelant.
 * Les tables absentes de l'instantané (inchangées) ne sont pas touchées.
 */
export async function applyCatalogSnapshot(db: Database, snapshot: CatalogSnapshot): Promise<void> {
  // Ordre logique (boutique avant emplacement, produit avant variante...) — les clés étrangères SQLite
  // ne sont pas activées dans ce projet, mais cet ordre évite un état intermédiaire incohérent.
  for (const name of REPLACED_TABLES) {
    const rows = snapshot[name];
    if (rows) await syncById(db, TABLE_OBJECTS[name] as IdTable, rows as Record<string, unknown>[]);
  }
  if (snapshot.stockBatches) await mergeBatches(db, snapshot.stockBatches);
  if (snapshot.customers) await mergeCustomers(db, snapshot.customers);
  if (snapshot.approvalRequests) {
    await replaceAll(db, schema.approvalRequests, snapshot.approvalRequests.map(({ id: _id, ...rest }) => rest));
  }
  if (snapshot.businessSettings) {
    const current = (await db.select().from(schema.businessSettings))[0] as Record<string, unknown> | undefined;
    const incoming: Record<string, unknown> = { ...snapshot.businessSettings };
    // Un rafraîchissement ne reprend pas les réglages propres à cet appareil (sauvegardes, imprimante).
    if (current) for (const k of DEVICE_LOCAL_SETTINGS) incoming[k] = current[k];
    await syncById(db, schema.businessSettings as IdTable, [incoming]);
  }
  if (snapshot.stockBalances) await rebaseStock(db, snapshot.stockBalances);

  await setCatalogHashes(db, { ...(await getCatalogHashes(db)), ...snapshot.hashes });
}

export const SNAPSHOT_TABLE_NAMES: readonly string[] = [...REPLACED_TABLES, ...MERGED_TABLES, "businessSettings"];
