// Événements de synchronisation — voir CLAUDE.md, mode réseau Phase 2. Ce
// module ne sait rien du réseau ni de l'UI (même principe de séparation des
// responsabilités que le reste de packages/core) : il ne fait que définir la
// forme des événements et un pub/sub minimal. C'est apps/web qui s'abonne
// (onSyncEvent) pour router chaque événement vers le Master/les Workers.
//
// Chaque type d'événement correspond exactement à l'effet complet d'une
// opération transactionnelle de packages/core (createSale,
// addManualStockEntry, recordStockLoss, transferStock, createExpense) — pas
// table par table, voir la justification dans le plan (une vente touche 7
// tables en une transaction, les répliquer indépendamment casserait la
// cohérence).
//
// Convention de références croisées à l'intérieur d'un payload : tout ce qui
// est **catalogue** (variantId, locationId, storeId, userId) reste un id
// local brut — ces tables n'ont qu'un seul écrivain (le Master, via
// l'instantané initial, voir snapshot.ts) donc les ids correspondent déjà
// des deux côtés. Tout ce qui peut être créé par PLUSIEURS appareils
// indépendamment (vente, lot de stock, client, ligne de fidélité...) est
// référencé par `syncId`, jamais par id local brut — voir applyRemoteEvents.ts
// pour la résolution.

export type SyncEventType =
  | "sale.created"
  | "stockEntry.created"
  | "stockLoss.created"
  | "stockTransfer.created"
  | "expense.created";

export interface SyncEvent<T = unknown> {
  eventId: string;
  type: SyncEventType;
  createdAt: string;
  payload: T;
}

export interface SyncSaleItemPayload {
  syncId: string;
  variantId: number;
  quantity: number;
  unitPrice: number;
  discount: number;
  taxRate: number;
  total: number;
}

export interface SyncStockMovementPayload {
  syncId: string;
  variantId: number;
  locationId: number;
  // Référence un lot par son identité universelle — un lot peut avoir été
  // créé par n'importe quel appareil (achat, transfert, entrée manuelle),
  // jamais un id local brut. `null` pour un mouvement sans lot (produit non
  // suivi en péremption, ou reliquat — voir consumeStockFefo).
  batchSyncId: string | null;
  quantityDelta: number;
  movementType: string;
  referenceType: string | null;
}

export interface SyncNewCustomerPayload {
  syncId: string;
  fullName: string;
}

export interface SaleCreatedEventPayload {
  sale: {
    syncId: string;
    number: string;
    // Client déjà connu (résolu par syncId côté récepteur), ou `null` si vente
    // sans client (client de passage anonyme). Mutuellement exclusif avec
    // `newCustomer` ci-dessous.
    customerSyncId: string | null;
    userId: number;
    storeId: number | null;
    saleMode: string;
    subtotal: number;
    discount: number;
    taxTotal: number;
    total: number;
    paymentStatus: string;
    createdAt: string;
  };
  // Présent seulement si la vente a créé un nouveau client de passage (nom
  // saisi sans client existant) — voir CustomersService.findOrCreateCustomerByName.
  newCustomer?: SyncNewCustomerPayload;
  items: SyncSaleItemPayload[];
  stockMovements: SyncStockMovementPayload[];
  payment?: { syncId: string; method: string; amount: number; storeId: number | null };
  credit?: { syncId: string; originalAmount: number; remainingBalance: number; storeId: number | null };
  loyaltyRedeem?: { syncId: string; pointsDelta: number };
  loyaltyEarn?: { syncId: string; pointsDelta: number };
}

export interface StockEntryCreatedEventPayload {
  batch?: { syncId: string; variantId: number; locationId: number; lotNumber: string | null; expiryDate: string | null; quantity: number };
  movement: SyncStockMovementPayload;
}

export interface StockLossCreatedEventPayload {
  movement: SyncStockMovementPayload;
}

export interface StockTransferCreatedEventPayload {
  // Une ligne par lot effectivement transféré (voir transferStock — FEFO,
  // peut répartir sur plusieurs lots), plus un éventuel reliquat sans lot.
  legs: Array<{
    sourceMovement: SyncStockMovementPayload;
    destMovement: SyncStockMovementPayload;
    destBatch?: { syncId: string; variantId: number; locationId: number; lotNumber: string | null; expiryDate: string | null; quantity: number; unitCost: number | null };
  }>;
}

export interface ExpenseCreatedEventPayload {
  expense: {
    syncId: string;
    category: string;
    amount: number;
    expenseDate: string;
    note: string | null;
    paymentMethod: string | null;
    userId: number | null;
    storeId: number | null;
  };
  payment: { syncId: string; method: string; amount: number; storeId: number | null; createdAt: string };
}

type SyncEventListener = (event: SyncEvent) => void;

const listeners = new Set<SyncEventListener>();

/**
 * Émet un événement déjà construit — à appeler uniquement APRÈS que la
 * transaction qui l'a produit a été validée (commit réussi de
 * `withTransaction`), jamais depuis l'intérieur de son callback : un
 * rollback après émission laisserait un événement fantôme référençant des
 * données jamais réellement écrites.
 */
export function emitSyncEvent(event: SyncEvent): void {
  for (const listener of listeners) listener(event);
}

/** S'abonne aux événements de synchronisation. Renvoie une fonction de désabonnement. */
export function onSyncEvent(listener: SyncEventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function buildSyncEvent<T>(type: SyncEventType, payload: T): SyncEvent<T> {
  return {
    eventId: crypto.randomUUID(),
    type,
    createdAt: new Date().toISOString(),
    payload,
  };
}
