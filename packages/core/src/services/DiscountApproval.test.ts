import { describe, expect, it } from "vitest";
import { canApprove, computeUnauthorizedDiscount } from "./ApprovalService";
import { computeRiskScore } from "./ControlsService";

const line = (over: Partial<Parameters<typeof computeUnauthorizedDiscount>[0]["lines"][number]> = {}) => ({
  quantity: 2,
  unitPrice: 1000,
  catalogPrice: 1000,
  promoPercent: 0,
  ...over,
});

describe("computeUnauthorizedDiscount", () => {
  it("vente au prix du catalogue sans remise : rien à approuver", () => {
    expect(computeUnauthorizedDiscount({ lines: [line()], invoiceDiscount: 0, invoicePromoPercent: 0 })).toBe(0);
  });

  it("prix vendu sous le catalogue : la baisse compte comme remise", () => {
    expect(computeUnauthorizedDiscount({ lines: [line({ unitPrice: 800 })], invoiceDiscount: 0, invoicePromoPercent: 0 })).toBe(400);
  });

  it("prix vendu au-dessus du catalogue : aucune remise", () => {
    expect(computeUnauthorizedDiscount({ lines: [line({ unitPrice: 1200 })], invoiceDiscount: 0, invoicePromoPercent: 0 })).toBe(0);
  });

  it("remise de ligne couverte exactement par une promotion en cours : autorisée", () => {
    const discount = (2 * 1000 * 10) / 100;
    expect(computeUnauthorizedDiscount({ lines: [line({ discount, promoPercent: 10 })], invoiceDiscount: 0, invoicePromoPercent: 0 })).toBe(0);
  });

  it("remise supérieure à la promotion : seul l'excédent est à approuver", () => {
    expect(computeUnauthorizedDiscount({ lines: [line({ discount: 500, promoPercent: 10 })], invoiceDiscount: 0, invoicePromoPercent: 0 })).toBe(300);
  });

  it("remise de ligne sans aucune promotion en cours : tout est à approuver", () => {
    expect(computeUnauthorizedDiscount({ lines: [line({ discount: 200 })], invoiceDiscount: 0, invoicePromoPercent: 0 })).toBe(200);
  });

  it("remise facture couverte par la promotion facture : autorisée", () => {
    // total après lignes = 2000 ; promotion facture 5 % = 100
    expect(computeUnauthorizedDiscount({ lines: [line()], invoiceDiscount: 100, invoicePromoPercent: 5 })).toBe(0);
  });

  it("remise facture supérieure à la promotion facture : excédent à approuver", () => {
    expect(computeUnauthorizedDiscount({ lines: [line()], invoiceDiscount: 300, invoicePromoPercent: 5 })).toBe(200);
  });

  it("tolère l'arrondi des pourcentages calculés côté écran", () => {
    const discount = 3 * 333.33 * 0.07; // 69.9993
    const line1 = { quantity: 3, unitPrice: 333.33, catalogPrice: 333.33, promoPercent: 7, discount: Math.round(discount * 100) / 100 };
    expect(computeUnauthorizedDiscount({ lines: [line1], invoiceDiscount: 0, invoicePromoPercent: 0 })).toBe(0);
  });
});

describe("canApprove", () => {
  it("approve_actions approuve tous les domaines", () => {
    expect(canApprove({ approve_actions: true }, "discount")).toBe(true);
    expect(canApprove({ approve_actions: true }, "stock")).toBe(true);
  });

  it("un droit par domaine n'approuve que ce domaine", () => {
    const perms = { approve_discounts: true };
    expect(canApprove(perms, "discount")).toBe(true);
    expect(canApprove(perms, "stock")).toBe(false);
    expect(canApprove(perms, "expense")).toBe(false);
  });

  it("sans aucun droit d'approbation : refusé", () => {
    expect(canApprove({ manage_stock: true }, "stock")).toBe(false);
  });
});

describe("computeRiskScore", () => {
  const base = {
    refundRate: 0,
    salesTotal: 100000,
    lossValue: 0,
    discountRate: 0,
    cashAlerts: 0,
    cashSessions: 5,
    failedApprovals: 0,
    manualEntryCount: 0,
    approvalsRejected: 0,
    priceChanges: 0,
    expenseEdits: 0,
  };
  const th = { refundRatePercent: 5, lossRatePercent: 2, discountRatePercent: 5 };

  it("employé sans signal : risque faible", () => {
    expect(computeRiskScore(base, th)).toEqual({ score: 0, level: "low" });
  });

  it("un seul signal au seuil pèse la moitié de son poids", () => {
    expect(computeRiskScore({ ...base, refundRate: 5 }, th).score).toBe(10);
  });

  it("plusieurs signaux forts cumulés : risque élevé", () => {
    const r = computeRiskScore({ ...base, refundRate: 12, lossValue: 6000, discountRate: 12, cashAlerts: 4, failedApprovals: 3 }, th);
    expect(r.level).toBe("high");
    expect(r.score).toBeGreaterThanOrEqual(60);
  });

  it("des pertes sans aucune vente comptent au maximum", () => {
    expect(computeRiskScore({ ...base, salesTotal: 0, lossValue: 500 }, th).score).toBe(20);
  });

  it("le score ne dépasse jamais 100", () => {
    const r = computeRiskScore(
      { ...base, refundRate: 100, lossValue: 100000, discountRate: 100, cashAlerts: 5, failedApprovals: 9, manualEntryCount: 9, approvalsRejected: 9, priceChanges: 9, expenseEdits: 9 },
      th,
    );
    expect(r.score).toBe(100);
  });
});
