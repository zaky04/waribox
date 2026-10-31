import { describe, expect, it } from "vitest";
import { allocateCostByQuantityShare, refundedCost } from "./ReportsService";

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

describe("refundedCost", () => {
  const base = { refundDate: "2026-09-25 10:00:00", total: 0, sale: {} as never };
  const item = { saleId: 7, variantId: 3, quantity: 4 } as never;

  it("annule le coût au prorata de la quantité remise en stock", () => {
    const costs = new Map([["7:3", 1000]]);
    const qty = new Map([["7:3", 4]]);
    expect(refundedCost({ ...base, quantity: 1, restocked: true, saleItem: item }, costs, qty)).toBe(250);
    expect(refundedCost({ ...base, quantity: 4, restocked: true, saleItem: item }, costs, qty)).toBe(1000);
  });

  it("ne touche pas au coût d'un article non remis en stock (marchandise perdue)", () => {
    const costs = new Map([["7:3", 1000]]);
    expect(refundedCost({ ...base, quantity: 2, restocked: false, saleItem: item }, costs, new Map([["7:3", 4]]))).toBe(0);
  });

  it("répartit correctement quand la même variante est sur deux lignes de la vente", () => {
    // groupe (vente 7, variante 3) : 6 unités pour 1200 de coût ; cette ligne en a 4
    const costs = new Map([["7:3", 1200]]);
    const qty = new Map([["7:3", 6]]);
    // coût de la ligne = 800 ; 1 unité remboursée sur 4 = 200
    expect(refundedCost({ ...base, quantity: 1, restocked: true, saleItem: item }, costs, qty)).toBe(200);
  });
});
