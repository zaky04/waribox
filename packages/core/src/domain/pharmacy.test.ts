import { describe, expect, it } from "vitest";
import { areEquivalent, breakdownUnitCost, missingPrescription, normalizeMolecule } from "./pharmacy";

describe("normalizeMolecule", () => {
  it("ignore accents, casse et espaces", () => {
    expect(normalizeMolecule("Paracétamol")).toBe("paracetamol");
    expect(normalizeMolecule("500 mg")).toBe(normalizeMolecule("500mg"));
    expect(normalizeMolecule(null)).toBe("");
  });
});

describe("areEquivalent", () => {
  const doliprane = { dci: "Paracétamol", dosage: "500 mg", dosageForm: "comprimé" };

  it("même DCI et même dosage = équivalents, malgré accents et espaces", () => {
    expect(areEquivalent(doliprane, { dci: "paracetamol", dosage: "500mg", dosageForm: "Comprimé" })).toBe(true);
  });
  it("dosage différent = pas équivalents", () => {
    expect(areEquivalent(doliprane, { dci: "paracetamol", dosage: "1000 mg" })).toBe(false);
  });
  it("DCI différente = pas équivalents", () => {
    expect(areEquivalent(doliprane, { dci: "ibuprofene", dosage: "500 mg" })).toBe(false);
  });
  it("sans DCI, jamais d'équivalence devinée", () => {
    expect(areEquivalent({ dosage: "500 mg" }, { dosage: "500 mg" })).toBe(false);
    expect(areEquivalent({ dci: "", dosage: "500 mg" }, { dci: "", dosage: "500 mg" })).toBe(false);
  });
  it("la forme ne départage que si les deux la renseignent", () => {
    expect(areEquivalent(doliprane, { dci: "paracetamol", dosage: "500mg" })).toBe(true);
    expect(areEquivalent(doliprane, { dci: "paracetamol", dosage: "500mg", dosageForm: "sirop" })).toBe(false);
  });
});

describe("breakdownUnitCost", () => {
  it("répartit le coût de la boîte sur ses unités", () => {
    expect(breakdownUnitCost(1000, 10)).toBe(100);
    expect(breakdownUnitCost(1000, 4)).toBe(250);
  });
  it("coût inconnu ou contenance invalide = pas de coût", () => {
    expect(breakdownUnitCost(null, 10)).toBeUndefined();
    expect(breakdownUnitCost(1000, 0)).toBeUndefined();
  });
});

describe("missingPrescription", () => {
  it("exige une référence dès qu'une ligne est sur ordonnance", () => {
    expect(missingPrescription([{ requiresPrescription: false }, { requiresPrescription: true }], "")).toBe(true);
    expect(missingPrescription([{ requiresPrescription: true }], "  ")).toBe(true);
    expect(missingPrescription([{ requiresPrescription: true }], "ORD-12")).toBe(false);
  });
  it("rien à exiger sans produit sur ordonnance", () => {
    expect(missingPrescription([{ requiresPrescription: false }], undefined)).toBe(false);
    expect(missingPrescription([], undefined)).toBe(false);
  });
});
