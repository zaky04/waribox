import { describe, expect, it } from "vitest";
import { CONTROL_PROFILE_IDS, getControlProfile, niceRound } from "../domain/controlProfiles";
import { withinApproveLimit } from "./ApprovalService";

describe("withinApproveLimit", () => {
  it("sans plafond : illimité", () => {
    expect(withinApproveLimit(null, "expense", 9_999_999)).toBe(true);
  });
  it("respecte le plafond (égal accepté)", () => {
    expect(withinApproveLimit(50000, "expense", 50000)).toBe(true);
    expect(withinApproveLimit(50000, "expense", 50001)).toBe(false);
  });
  it("les points ne sont pas un montant : hors plafond", () => {
    expect(withinApproveLimit(10, "points", 5000)).toBe(true);
  });
  it("plafond à 0 : rien n'est approuvable", () => {
    expect(withinApproveLimit(0, "refund", 1)).toBe(false);
  });
});

describe("profils de contrôle", () => {
  it("niceRound garde 2 chiffres significatifs", () => {
    expect(niceRound(7.6)).toBe(8);
    expect(niceRound(1234)).toBe(1200);
    expect(niceRound(0)).toBe(0);
  });
  it("présent : tout à 0 en PIN", () => {
    const p = getControlProfile("present");
    expect(p.approvalExpenseThreshold).toBe(0);
    expect(p.approvalModeExpense).toBe("pin");
  });
  it("les seuils sont mis à l'échelle de la devise mais jamais à 0 par erreur", () => {
    const xof = getControlProfile("periodic", "XOF");
    const eur = getControlProfile("periodic", "EUR");
    expect(xof.approvalDiscountThreshold).toBe(5000);
    expect(eur.approvalDiscountThreshold).toBeGreaterThan(0);
    expect(eur.approvalDiscountThreshold).toBeLessThan(20);
  });
  it("plus le propriétaire est absent, plus le délai d'alerte est long", () => {
    const hours = CONTROL_PROFILE_IDS.map((id) => getControlProfile(id).approvalPendingAlertHours);
    expect(hours).toEqual([...hours].sort((a, b) => a - b));
  });
});
