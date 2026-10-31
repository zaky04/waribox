import { formatAmount, formatAmountPlain, formatMoney, formatMoneyPlain, setCurrency, t } from "@gestion-boutique/i18n";
import { afterAll, describe, expect, it } from "vitest";
import { roundMoney } from "./money";

const NBSP = " ";

describe("formatage des devises", () => {
  afterAll(() => setCurrency("XOF"));

  it("XOF : entier, séparateur insécable, symbole après", () => {
    setCurrency("XOF");
    expect(formatAmount(142500)).toBe(`142${NBSP}500`);
    expect(formatMoney(142500)).toBe(`142${NBSP}500${NBSP}F`);
    expect(formatAmount(1234.6)).toBe(`1${NBSP}235`);
  });

  it("NGN : 2 décimales, virgule de milliers, symbole avant", () => {
    setCurrency("NGN");
    expect(formatAmount(1500)).toBe("1,500.00");
    expect(formatMoney(1500.5)).toBe("₦1,500.50");
    expect(formatMoney(-25)).toBe("-₦25.00");
  });

  it("EUR : virgule décimale, symbole après", () => {
    setCurrency("EUR");
    expect(formatAmount(1234.5)).toBe(`1${NBSP}234,50`);
    expect(formatMoney(12.5)).toBe(`12,50${NBSP}€`);
  });

  it("documents : ASCII uniquement, avec code de devise sur les totaux", () => {
    setCurrency("GHS");
    expect(formatAmountPlain(1234.5)).toBe("1,234.50");
    expect(formatMoneyPlain(1234.5)).toBe("1,234.50 GHS");
    setCurrency("EUR");
    expect(formatAmountPlain(1234.5)).toBe("1 234,50");
    expect(formatMoneyPlain(9)).toBe("9,00 EUR");
  });

  it("devise inconnue : retombe sur XOF", () => {
    setCurrency("???");
    expect(formatMoney(500)).toBe(`500${NBSP}F`);
  });

  it("le libellé du mode de paiement suit le pays", () => {
    setCurrency("NGN");
    expect(t("sales.paymentMethods.mobile_money", { lng: "en" })).toBe("Transfer / mobile");
    setCurrency("GHS");
    expect(t("sales.paymentMethods.mobile_money", { lng: "en" })).toBe("Mobile Money");
    setCurrency("XOF");
    expect(t("sales.paymentMethods.mobile_money", { lng: "fr" })).toBe("Mobile Money");
  });
});

describe("roundMoney", () => {
  it("efface les résidus de virgule flottante", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(3 * 0.1)).toBe(0.3);
  });
  it("ne change pas les montants entiers", () => {
    expect(roundMoney(142500)).toBe(142500);
    expect(roundMoney(0)).toBe(0);
  });
});
