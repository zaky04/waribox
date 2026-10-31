import { describe, expect, it } from "vitest";
import { computeVariances } from "./InventoryService";
import { priceIncreasePercent } from "./PurchasesService";
import { diffFields } from "./ProductsService";

describe("écarts d'inventaire", () => {
  const lines = [
    { variantId: 1, countedQuantity: 4, unitCost: 95000 },
    { variantId: 2, countedQuantity: 12, unitCost: 2500 },
    { variantId: 3, countedQuantity: 11, unitCost: 6000 },
    { variantId: 4, countedQuantity: null, unitCost: 100 },
  ];
  const system = new Map([[1, 5], [2, 12], [3, 10], [4, 7]]);

  it("calcule manquants et surplus valorisés, ignore les produits non comptés", () => {
    const v = computeVariances(lines, system);
    expect(v.map((x) => x.variantId)).toEqual([1, 2, 3]);
    expect(v[0]).toMatchObject({ difference: -1, value: -95000 });
    expect(v[1]).toMatchObject({ difference: 0, value: 0 });
    expect(v[2]).toMatchObject({ difference: 1, value: 6000 });
  });

  it("gère les quantités décimales sans résidu flottant", () => {
    const v = computeVariances([{ variantId: 1, countedQuantity: 0.3, unitCost: 10 }], new Map([[1, 0.1 + 0.2]]));
    expect(v[0]!.difference).toBe(0);
  });
});

describe("hausse de prix d'achat", () => {
  it("retourne le pourcentage de hausse, 0 sinon", () => {
    expect(priceIncreasePercent(95000, 110000)).toBeCloseTo(15.79, 1);
    expect(priceIncreasePercent(100, 100)).toBe(0);
    expect(priceIncreasePercent(100, 80)).toBe(0);
    expect(priceIncreasePercent(undefined, 500)).toBe(0);
    expect(priceIncreasePercent(0, 500)).toBe(0);
  });
});

describe("diffFields", () => {
  it("ne garde que les champs modifiés avec ancienne et nouvelle valeur", () => {
    const before = { name: "A", salePrice: 100, unit: "pcs" };
    const after = { name: "A", salePrice: 150, unit: "pcs" };
    expect(diffFields(before, after, ["name", "salePrice", "unit"])).toEqual({ salePrice: { from: 100, to: 150 } });
  });
  it("aucune différence si l'état précédent est inconnu", () => {
    expect(diffFields(undefined, { name: "A" }, ["name"])).toEqual({});
  });
});
