import { describe, expect, it } from "vitest";
import { seasonalEventsOfYear, seasonalOutlook, suggestRestockQuantity } from "./seasonality";

describe("fêtes connues", () => {
  it("chaque année a les fêtes fixes, les fêtes lunaires jusqu'en 2030", () => {
    expect(seasonalEventsOfYear(2026).map((e) => e.key).sort()).toEqual(["backToSchool", "christmas", "eidFitr", "newYear", "ramadan", "tabaski"]);
    expect(seasonalEventsOfYear(2031).map((e) => e.key).sort()).toEqual(["backToSchool", "christmas", "newYear"]);
    for (let year = 2026; year <= 2030; year++) {
      const byKey = Object.fromEntries(seasonalEventsOfYear(year).map((e) => [e.key, e.date]));
      expect(byKey.ramadan! < byKey.eidFitr!).toBe(true); // le Ramadan précède l'Aïd
      expect(byKey.eidFitr! < byKey.tabaski!).toBe(true); // l'Aïd précède Tabaski
      expect(byKey.tabaski!.startsWith(String(year))).toBe(true);
    }
  });
});

describe("coefficient moyen sur l'horizon", () => {
  it("aucune fête dans l'horizon : 1", () => {
    expect(seasonalOutlook("2026-06-10", 30)).toEqual({ factor: 1, events: [] });
    expect(seasonalOutlook("2026-06-10", 0)).toEqual({ factor: 1, events: [] });
  });

  it("Tabaski dans 17 jours : la hausse ne pèse que sur la part de l'horizon qui la contient", () => {
    const outlook = seasonalOutlook("2026-05-10", 30);
    // Période de hausse : 6 mai → 27 mai (21 jours avant). Du 10 au 27 mai : 18 jours à 1,5 ; 12 jours à 1.
    expect(outlook.factor).toBe(1.3);
    expect(outlook.events).toEqual([{ key: "tabaski", date: "2026-05-27", daysUntil: 17, factor: 1.5 }]);
  });

  it("la veille de la fête, tout l'horizon proche est gonflé ; une fois passée, la hausse disparaît", () => {
    expect(seasonalOutlook("2026-05-26", 2).factor).toBe(1.5);
    expect(seasonalOutlook("2026-05-28", 30).factor).toBe(1); // lendemain de Tabaski
  });

  it("plusieurs fêtes qui se chevauchent : la plus forte l'emporte chaque jour, sans les additionner", () => {
    // 1er-25 décembre : Noël (14 j avant) seulement ; fin décembre : Noël puis Nouvel An (10 j avant le 1er janvier).
    const outlook = seasonalOutlook("2026-12-20", 15); // 20 déc → 3 janv
    expect(outlook.events.map((e) => e.key)).toEqual(["christmas", "newYear"]);
    // 20-25 déc : 6 jours à 1,4 ; 26 déc-1er janv : 7 jours à 1,3 ; 2-3 janv : 2 jours à 1 → (8,4 + 9,1 + 2) / 15.
    expect(outlook.factor).toBe(1.3);
  });

  it("le changement d'année est géré (fêtes de l'année suivante vues depuis décembre)", () => {
    expect(seasonalOutlook("2026-12-25", 10).events.map((e) => e.key)).toContain("newYear");
    expect(seasonalOutlook("2029-12-28", 40).events.map((e) => e.key)).toContain("ramadan"); // Ramadan 2030
  });
});

describe("quantité à commander", () => {
  const base = { stock: 10, horizonDays: 30, lowStockThreshold: 5 };
  it("rythme réel × horizon − stock, comme avant les fêtes", () => {
    expect(suggestRestockQuantity({ ...base, dailyVelocity: 2 })).toBe(50);
    expect(suggestRestockQuantity({ ...base, dailyVelocity: 2, seasonFactor: 1 })).toBe(50);
  });
  it("le coefficient des fêtes gonfle la commande", () => {
    expect(suggestRestockQuantity({ ...base, dailyVelocity: 2, seasonFactor: 1.3 })).toBe(68);
    expect(suggestRestockQuantity({ ...base, dailyVelocity: 2, seasonFactor: 0 })).toBe(50); // coefficient invalide ignoré
  });
  it("sans ventes : double du seuil moins le stock, coefficient sans effet ; jamais moins de 1", () => {
    expect(suggestRestockQuantity({ ...base, dailyVelocity: 0, stock: 2 })).toBe(8);
    expect(suggestRestockQuantity({ ...base, dailyVelocity: 0, stock: 2, seasonFactor: 1.5 })).toBe(8);
    expect(suggestRestockQuantity({ ...base, dailyVelocity: 0.1, stock: 50 })).toBe(1);
    expect(suggestRestockQuantity({ ...base, dailyVelocity: 0, stock: 99 })).toBe(1);
  });
});
