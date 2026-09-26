import { describe, expect, it } from "vitest";
import { buildDailySummaryText, type DailySummary } from "./DailySummaryService";
import { findNumberGaps } from "./ControlsService";
import { computeTicketUnauthorizedDiscount } from "./ServiceOrdersService";

describe("computeTicketUnauthorizedDiscount", () => {
  it("saisie manuelle sans remise : rien à approuver", () => {
    expect(computeTicketUnauthorizedDiscount([{ quantity: 2, unitPrice: 500 }])).toBe(0);
  });

  it("saisie manuelle avec remise : la remise est à approuver", () => {
    expect(computeTicketUnauthorizedDiscount([{ quantity: 1, unitPrice: 1000, discount: 200 }])).toBe(200);
  });

  it("ligne issue d'un tarif au prix du tarif : rien à approuver", () => {
    expect(computeTicketUnauthorizedDiscount([{ quantity: 3, unitPrice: 300, tariffPrice: 300 }])).toBe(0);
  });

  it("ligne issue d'un tarif vendue moins cher : la baisse est à approuver", () => {
    expect(computeTicketUnauthorizedDiscount([{ quantity: 3, unitPrice: 200, tariffPrice: 300 }])).toBe(300);
  });

  it("ligne vendue plus cher que le tarif : aucune remise", () => {
    expect(computeTicketUnauthorizedDiscount([{ quantity: 1, unitPrice: 400, tariffPrice: 300 }])).toBe(0);
  });

  it("additionne baisse de prix et remise sur plusieurs lignes", () => {
    expect(
      computeTicketUnauthorizedDiscount([
        { quantity: 1, unitPrice: 250, tariffPrice: 300 },
        { quantity: 1, unitPrice: 1000, discount: 100 },
      ]),
    ).toBe(150);
  });
});

describe("findNumberGaps", () => {
  it("suite complète : aucun trou", () => {
    expect(findNumberGaps(["TCK-2026-000001", "TCK-2026-000002", "TCK-2026-000003"])).toEqual([]);
  });

  it("détecte un numéro manquant au milieu", () => {
    expect(findNumberGaps(["TCK-2026-000001", "TCK-2026-000003", "TCK-2026-000004"])).toEqual(["TCK-2026-000002"]);
  });

  it("sépare les années et ignore les formats inconnus", () => {
    expect(findNumberGaps(["VTE-2025-000001", "VTE-2026-000002", "n'importe quoi"])).toEqual(["VTE-2026-000001"]);
  });

  it("aucun numéro : rien", () => {
    expect(findNumberGaps([])).toEqual([]);
  });
});

describe("buildDailySummaryText", () => {
  const summary: DailySummary = {
    date: "2026-09-26",
    salesCount: 12,
    salesTotal: 84500,
    ticketsCount: 5,
    ticketsTotal: 22000,
    refundsCount: 1,
    refundsTotal: 3000,
    discountCount: 2,
    discountTotal: 1500,
    lossCount: 1,
    lossValue: 5000,
    entryCount: 0,
    entryValue: 0,
    expensesCount: 1,
    expensesTotal: 15000,
    cashSessionsClosed: 1,
    cashVariance: -500,
    ticketsCancelled: 1,
    approvalsCount: 4,
    alertsCount: 3,
    dangerAlerts: 1,
  };

  it("produit un texte lisible, sans clé de traduction brute", () => {
    const text = buildDailySummaryText(summary, "Pressing Test");
    expect(text).toContain("2026-09-26");
    expect(text).toContain("Pressing Test");
    expect(text).not.toMatch(/dailySummary\./);
    expect(text.split("\n").length).toBeGreaterThan(8);
  });
});
