// Logique pure de péremption (aucun accès base) : testable sans harnais SQLite.
//
// Règle métier : un lot est périmé quand sa date de péremption est STRICTEMENT
// antérieure à aujourd'hui (le jour indiqué est encore bon). Un lot périmé ne
// se vend plus, ne se transfère plus vers la surface de vente, et ne peut
// repartir que par un rebut tracé — ou par une dérogation d'un responsable.

// Date locale du jour au format "YYYY-MM-DD" (les dates de péremption sont
// saisies et stockées dans ce format, sans heure ni fuseau).
export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Levée par une vente qui aurait besoin de lots périmés : l'interface la
// reconnaît pour proposer la dérogation d'un responsable plutôt qu'un simple
// message d'erreur.
export class ExpiredStockError extends Error {
  available: number;
  expired: number;
  constructor(message: string, available: number, expired: number) {
    super(message);
    this.name = "ExpiredStockError";
    this.available = available;
    this.expired = expired;
  }
}

export function isExpired(expiryDate: string | null | undefined, today: string): boolean {
  if (!expiryDate) return false;
  return expiryDate.slice(0, 10) < today;
}

// Jours restants avant péremption (négatif si déjà périmé).
export function daysUntilExpiry(expiryDate: string, today: string): number {
  const toUtcDay = (iso: string) => {
    const [y = 0, m = 1, d = 1] = iso.slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
  };
  return Math.round(toUtcDay(expiryDate) - toUtcDay(today));
}

export type ExpiryTier = "expired" | "within30" | "within60" | "within90" | "later";

export function expiryTier(expiryDate: string | null | undefined, today: string): ExpiryTier {
  if (!expiryDate) return "later";
  const days = daysUntilExpiry(expiryDate, today);
  if (days < 0) return "expired";
  if (days <= 30) return "within30";
  if (days <= 60) return "within60";
  if (days <= 90) return "within90";
  return "later";
}

export interface BatchWithRemaining {
  batch: { id: number; expiryDate: string | null };
  remaining: number;
}

// Ordre FEFO (péremption la plus proche d'abord, sans date en dernier) des
// lots qui ont encore du stock. Les lots périmés sont exclus, sauf demande
// explicite (`includeExpired`, pour un rebut ou une dérogation approuvée).
export function selectBatchesForConsumption<T extends BatchWithRemaining>(
  items: T[],
  today: string,
  options: { includeExpired: boolean },
): T[] {
  return items
    .filter((item) => item.remaining > 0)
    .filter((item) => options.includeExpired || !isExpired(item.batch.expiryDate, today))
    .sort((a, b) => {
      if (!a.batch.expiryDate && !b.batch.expiryDate) return a.batch.id - b.batch.id;
      if (!a.batch.expiryDate) return 1;
      if (!b.batch.expiryDate) return -1;
      return a.batch.expiryDate.localeCompare(b.batch.expiryDate);
    });
}

// Quantité réellement vendable à un emplacement = solde - lots périmés.
//
// `untagged = total - Σ(tous les lots)` : du stock sans lot (produits jamais
// suivis par lot) s'il est positif ; s'il est NÉGATIF, des sorties ont été
// enregistrées sans lot (ex. l'ancien « retrait pour péremption », qui ne
// touchait pas au lot). On suppose alors que ces sorties ont déjà évacué les
// périmés en premier — sinon un produit dont on a jeté les périmés à la main
// resterait bloqué à tort.
export function computeSellableQuantity(input: {
  total: number;
  expiredRemaining: number;
  allBatchesRemaining: number;
}): number {
  const untagged = input.total - input.allBatchesRemaining;
  const deficit = untagged < 0 ? -untagged : 0;
  const expiredEffective = Math.max(0, input.expiredRemaining - deficit);
  return Math.max(0, input.total - expiredEffective);
}
