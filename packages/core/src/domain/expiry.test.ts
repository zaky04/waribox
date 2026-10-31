import { describe, expect, it } from "vitest";
import {
  computeSellableQuantity,
  daysUntilExpiry,
  expiryTier,
  isExpired,
  selectBatchesForConsumption,
  todayISO,
} from "./expiry";

const batch = (id: number, expiryDate: string | null, remaining: number) => ({
  batch: { id, expiryDate },
  remaining,
});

describe("isExpired", () => {
  it("le jour de péremption est encore bon, le lendemain non", () => {
    expect(isExpired("2026-10-18", "2026-10-18")).toBe(false);
    expect(isExpired("2026-10-17", "2026-10-18")).toBe(true);
  });
  it("sans date, jamais périmé", () => {
    expect(isExpired(null, "2026-10-18")).toBe(false);
    expect(isExpired(undefined, "2026-10-18")).toBe(false);
  });
  it("accepte une date avec heure", () => {
    expect(isExpired("2026-10-17 08:00:00", "2026-10-18")).toBe(true);
  });
});

describe("todayISO", () => {
  it("formate en date locale sur 10 caractères", () => {
    expect(todayISO(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(todayISO(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("daysUntilExpiry / expiryTier", () => {
  it("compte les jours restants", () => {
    expect(daysUntilExpiry("2026-10-28", "2026-10-18")).toBe(10);
    expect(daysUntilExpiry("2026-10-17", "2026-10-18")).toBe(-1);
  });
  it("range un lot dans le bon palier", () => {
    const today = "2026-10-18";
    expect(expiryTier("2026-10-01", today)).toBe("expired");
    expect(expiryTier("2026-10-18", today)).toBe("within30");
    expect(expiryTier("2026-11-17", today)).toBe("within30"); // 30 jours pile
    expect(expiryTier("2026-11-18", today)).toBe("within60");
    expect(expiryTier("2026-12-17", today)).toBe("within60");
    expect(expiryTier("2026-12-18", today)).toBe("within90");
    expect(expiryTier("2027-01-16", today)).toBe("within90"); // 90 jours pile
    expect(expiryTier("2027-01-17", today)).toBe("later");
    expect(expiryTier(null, today)).toBe("later");
  });
});

describe("selectBatchesForConsumption", () => {
  const today = "2026-10-18";
  const items = [
    batch(1, "2026-12-01", 5),
    batch(2, "2026-09-01", 4), // périmé
    batch(3, null, 7),
    batch(4, "2026-11-01", 0), // épuisé
    batch(5, "2026-10-25", 3),
  ];

  it("exclut les périmés et les lots épuisés, FEFO, sans date en dernier", () => {
    const ids = selectBatchesForConsumption(items, today, { includeExpired: false }).map((i) => i.batch.id);
    expect(ids).toEqual([5, 1, 3]);
  });

  it("avec dérogation, le périmé passe en premier (FEFO)", () => {
    const ids = selectBatchesForConsumption(items, today, { includeExpired: true }).map((i) => i.batch.id);
    expect(ids).toEqual([2, 5, 1, 3]);
  });

  it("deux lots sans date : le plus ancien d'abord", () => {
    const ids = selectBatchesForConsumption([batch(9, null, 1), batch(8, null, 1)], today, { includeExpired: false }).map(
      (i) => i.batch.id,
    );
    expect(ids).toEqual([8, 9]);
  });
});

describe("computeSellableQuantity", () => {
  it("retire les périmés du solde", () => {
    expect(computeSellableQuantity({ total: 15, expiredRemaining: 10, allBatchesRemaining: 15 })).toBe(5);
  });
  it("tout périmé = rien de vendable", () => {
    expect(computeSellableQuantity({ total: 10, expiredRemaining: 10, allBatchesRemaining: 10 })).toBe(0);
  });
  it("stock sans lot (jamais suivi) reste vendable", () => {
    expect(computeSellableQuantity({ total: 20, expiredRemaining: 0, allBatchesRemaining: 0 })).toBe(20);
    expect(computeSellableQuantity({ total: 20, expiredRemaining: 8, allBatchesRemaining: 8 })).toBe(12);
  });
  it("ancienne sortie sans lot : on suppose qu'elle a évacué les périmés d'abord", () => {
    // 10 périmés + 5 valides en lots (15), mais le solde n'est que de 5 : 10 unités ont été
    // jetées à la main sans toucher au lot → les 5 restantes sont bien vendables.
    expect(computeSellableQuantity({ total: 5, expiredRemaining: 10, allBatchesRemaining: 15 })).toBe(5);
  });
  it("sortie sans lot partielle : le déficit réduit d'autant les périmés", () => {
    // 10 périmés + 5 valides, solde 12 (3 jetées sans lot) → il reste 7 périmés, donc 5 vendables.
    expect(computeSellableQuantity({ total: 12, expiredRemaining: 10, allBatchesRemaining: 15 })).toBe(5);
  });
  it("jamais négatif", () => {
    expect(computeSellableQuantity({ total: 0, expiredRemaining: 10, allBatchesRemaining: 10 })).toBe(0);
  });
});
