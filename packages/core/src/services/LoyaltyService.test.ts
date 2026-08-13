import { describe, expect, it } from "vitest";
import { computeTier, pointsToDiscount } from "./LoyaltyService";

describe("pointsToDiscount", () => {
  it("converts points to a discount using the inverse of the earning ratio", () => {
    expect(pointsToDiscount(100, 10)).toBeCloseTo(10, 6);
  });

  it("returns zero when the ratio is zero (fidélité désactivée)", () => {
    expect(pointsToDiscount(100, 0)).toBe(0);
  });
});

describe("computeTier", () => {
  it("starts at bronze below the silver threshold", () => {
    expect(computeTier(0, 5000, 20000)).toBe("bronze");
    expect(computeTier(4999, 5000, 20000)).toBe("bronze");
  });

  it("reaches silver exactly at the threshold (inclusive)", () => {
    expect(computeTier(5000, 5000, 20000)).toBe("silver");
  });

  it("reaches gold exactly at the threshold (inclusive)", () => {
    expect(computeTier(20000, 5000, 20000)).toBe("gold");
  });

  it("stays gold above the threshold", () => {
    expect(computeTier(50000, 5000, 20000)).toBe("gold");
  });
});
