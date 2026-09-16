import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";

// Instantané initial du catalogue — voir CLAUDE.md, mode réseau Phase 2.
// Téléchargement à SENS UNIQUE (Master → Worker), une seule fois à la toute
// première connexion d'un Worker (voir __sync_state.lastAppliedSeq absent) —
// PAS une synchronisation continue : si le Master modifie un produit après
// coup, un Worker déjà apparié ne le voit pas avant la Phase 3 (RPC
// catalogue). Ces tables n'ont qu'un seul écrivain tant que la Phase 3
// n'existe pas, donc les ids locaux sont recopiés tels quels (pas de
// traduction par syncId, contrairement aux données transactionnelles de
// applyRemoteEvents.ts) — aucune collision possible sur un Worker qui vient
// de "repartir à zéro" (voir la décision Solo→réseau).
export interface CatalogSnapshot {
  categories: Array<typeof schema.categories.$inferSelect>;
  products: Array<typeof schema.products.$inferSelect>;
  productVariants: Array<typeof schema.productVariants.$inferSelect>;
  stores: Array<typeof schema.stores.$inferSelect>;
  stockLocations: Array<typeof schema.stockLocations.$inferSelect>;
  // Lots déjà existants au moment de l'appairage — sans eux, les mouvements
  // de stock déjà passés au Master (et donc son niveau de stock réel) ne
  // seraient pas visibles pour un Worker qui vend depuis ce même stock.
  // Limite connue : seuls les LOTS sont recopiés, pas l'historique des
  // mouvements qui les ont remplis — voir applyCatalogSnapshot.
  stockBatches: Array<typeof schema.stockBatches.$inferSelect>;
  customers: Array<typeof schema.customers.$inferSelect>;
  suppliers: Array<typeof schema.suppliers.$inferSelect>;
  roles: Array<typeof schema.roles.$inferSelect>;
  users: Array<typeof schema.users.$inferSelect>;
  // Le code de maintenance protège une action desktop-only (installer une
  // mise à jour, voir MaintenanceService/tauriRuntime.isDesktopTauriRuntime)
  // sans rapport avec ce qu'un Worker a besoin de faire — l'envoyer dans
  // l'instantané ne ferait qu'exposer un secret supplémentaire sur un
  // appareil qui n'en a aucun usage. Voir l'audit de sécurité du 2026-09-07
  // (Vuln 2) : contrairement à passwordHash/pinHash (nécessaires pour que
  // "le gérant se connecte depuis un Worker avec son compte habituel",
  // décision déjà actée — voir CLAUDE.md Phase 1), maintenanceCodeHash n'a
  // aucune contrepartie fonctionnelle à perdre.
  businessSettings: Omit<typeof schema.businessSettings.$inferSelect, "maintenanceCodeHash" | "maintenanceCodeFailedAttempts" | "maintenanceCodeLockedUntil"> | undefined;
}

/** Construit l'instantané — appelé côté Master, à la connexion d'un Worker jamais synchronisé. */
export async function buildCatalogSnapshot(db: Database): Promise<CatalogSnapshot> {
  const [
    categories,
    products,
    productVariants,
    stores,
    stockLocations,
    stockBatches,
    customers,
    suppliers,
    roles,
    users,
    businessSettingsRows,
  ] = await Promise.all([
    db.select().from(schema.categories),
    db.select().from(schema.products),
    db.select().from(schema.productVariants),
    db.select().from(schema.stores),
    db.select().from(schema.stockLocations),
    db.select().from(schema.stockBatches),
    db.select().from(schema.customers),
    db.select().from(schema.suppliers),
    db.select().from(schema.roles),
    db.select().from(schema.users),
    db.select().from(schema.businessSettings),
  ]);

  // Retire le secret de maintenance avant transmission (voir le commentaire
  // sur CatalogSnapshot.businessSettings ci-dessus) — jamais envoyé sur le
  // fil, quel que soit le canal.
  const businessSettingsRow = businessSettingsRows[0];
  const businessSettings = businessSettingsRow
    ? (() => {
        const { maintenanceCodeHash, maintenanceCodeFailedAttempts, maintenanceCodeLockedUntil, ...rest } = businessSettingsRow;
        return rest;
      })()
    : undefined;

  return {
    categories,
    products,
    productVariants,
    stores,
    stockLocations,
    stockBatches,
    customers,
    suppliers,
    roles,
    users,
    businessSettings,
  };
}

// Vide une table dans le SEUL contexte de l'instantané initial (voir
// applyCatalogSnapshot) : un Worker qui reçoit son tout premier instantané a
// déjà, par le bootstrap standard de toute installation WariBox, une
// boutique/des rôles/des paramètres d'entreprise par défaut — il faut les
// remplacer par les vraies données du Master, pas les cumuler.
async function replaceAll<T extends Record<string, unknown>>(
  db: Database,
  table: Parameters<Database["delete"]>[0],
  rows: T[],
): Promise<void> {
  await db.delete(table).run();
  for (const row of rows) {
    await db.insert(table).values(row).run();
  }
}

/**
 * Applique l'instantané reçu à la base locale — appelé côté Worker, une
 * seule fois, avant toute autre écriture métier. Voir le commentaire de
 * `replaceAll` : les tables cibles sont d'abord vidées (bootstrap par
 * défaut écrasé), pas fusionnées.
 */
export async function applyCatalogSnapshot(db: Database, snapshot: CatalogSnapshot): Promise<void> {
  // Ordre choisi pour respecter les dépendances logiques (catégorie avant
  // produit, produit avant variante, boutique avant emplacement...) — la
  // contrainte FK SQLite n'est pas activée dans ce projet, mais suivre cet
  // ordre évite malgré tout un état transitoire incohérent en cas d'erreur
  // au milieu de l'opération.
  await replaceAll(db, schema.roles, snapshot.roles);
  await replaceAll(db, schema.stores, snapshot.stores);
  await replaceAll(db, schema.users, snapshot.users);
  await replaceAll(db, schema.categories, snapshot.categories);
  await replaceAll(db, schema.products, snapshot.products);
  await replaceAll(db, schema.productVariants, snapshot.productVariants);
  await replaceAll(db, schema.stockLocations, snapshot.stockLocations);
  await replaceAll(db, schema.stockBatches, snapshot.stockBatches);
  await replaceAll(db, schema.customers, snapshot.customers);
  await replaceAll(db, schema.suppliers, snapshot.suppliers);
  if (snapshot.businessSettings) {
    await replaceAll(db, schema.businessSettings, [snapshot.businessSettings]);
  }
}
