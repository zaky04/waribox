import { describe, expect, it } from "vitest";
import { computeSaleItemTotal, computeTaxAmount } from "./SalesService";

describe("computeSaleItemTotal", () => {
  it("multiplies quantity by unit price", () => {
    expect(computeSaleItemTotal({ variantId: 1, quantity: 3, unitPrice: 100 })).toBe(300);
  });

  it("subtracts the line discount", () => {
    expect(computeSaleItemTotal({ variantId: 1, quantity: 3, unitPrice: 100, discount: 50 })).toBe(250);
  });

  it("treats a missing discount as zero", () => {
    expect(computeSaleItemTotal({ variantId: 1, quantity: 2, unitPrice: 500 })).toBe(1000);
  });
});

describe("computeTaxAmount", () => {
  it("returns zero for a zero or negative tax rate", () => {
    expect(computeTaxAmount(1180, 0)).toBe(0);
    expect(computeTaxAmount(1180, -5)).toBe(0);
  });

  it("extracts the VAT already included in a TTC amount (not added on top)", () => {
    // 1180 TTC à 18% => 1000 HT + 180 de TVA. Une erreur classique serait de
    // faire 1180 * 0.18 = 212.4, ce qui ajouterait la taxe au lieu de l'extraire.
    expect(computeTaxAmount(1180, 18)).toBeCloseTo(180, 6);
  });

  it("returns zero on a zero gross amount", () => {
    expect(computeTaxAmount(0, 18)).toBe(0);
  });
});
