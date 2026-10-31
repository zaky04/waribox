import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDayEndUtc, localDayStartUtc, utcToLocalDay } from "./localDay";

// Les tests tournent dans un fuseau choisi (Lagos = UTC+1, sans heure d'été) pour vérifier le
// décalage ; le fuseau d'origine est rétabli ensuite.
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Africa/Lagos";
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe("jours locaux et horodatages UTC (fuseau UTC+1)", () => {
  it("le jour local commence à 23:00 UTC la veille", () => {
    expect(localDayStartUtc("2026-03-02")).toBe("2026-03-01 23:00:00");
    expect(localDayEndUtc("2026-03-02")).toBe("2026-03-02 22:59:59");
  });

  it("une vente à 23:30 UTC appartient au jour local suivant", () => {
    expect(utcToLocalDay("2026-03-01 23:30:00")).toBe("2026-03-02");
    expect(utcToLocalDay("2026-03-01 22:59:59")).toBe("2026-03-01");
  });

  it("les bornes d'un jour ne se chevauchent pas et se touchent à la seconde", () => {
    const endMarch1 = localDayEndUtc("2026-03-01"); // 21:59:59 UTC... + 1 = 22:59:59 UTC
    const startMarch2 = localDayStartUtc("2026-03-02");
    expect(endMarch1 < startMarch2).toBe(true);
    expect(utcToLocalDay(endMarch1)).toBe("2026-03-01");
    expect(utcToLocalDay(startMarch2)).toBe("2026-03-02");
  });

  it("accepte un horodatage ISO et un texte invalide sans planter", () => {
    expect(utcToLocalDay("2026-03-01T23:30:00Z")).toBe("2026-03-02");
    expect(utcToLocalDay("n'importe quoi")).toBe("n'importe ");
    expect(localDayStartUtc("pas une date")).toBe("pas une da 00:00:00");
  });
});
