import { describe, expect, it } from "vitest";
import { allocateCostByQuantityShare } from "./ReportsService";

describe("allocateCostByQuantityShare", () => {
  it("returns the full cost when the line is the only one in the group", () => {
    expect(allocateCostByQuantityShare(1000, 5, 5)).toBe(1000);
  });

  it("splits the group cost proportionally across two lines of the same variant", () => {
    // Deux lignes de vente pour la même variante dans la même vente (rare
    // mais possible) — le coût du groupe (mouvements de stock non distingués
    // par ligne) doit se répartir au prorata de la quantité de chaque ligne.
    expect(allocateCostByQuantityShare(900, 3, 9)).toBeCloseTo(300, 6);
    expect(allocateCostByQuantityShare(900, 6, 9)).toBeCloseTo(600, 6);
  });

  it("returns zero rather than dividing by zero when the group has no quantity", () => {
    expect(allocateCostByQuantityShare(500, 2, 0)).toBe(0);
  });
});
