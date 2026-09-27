import { describe, expect, it } from "vitest";
import { findCountryByDialCode, toInternationalDigits } from "@gestion-boutique/i18n";

describe("numéros de téléphone internationaux", () => {
  it("Côte d'Ivoire : le 0 initial est conservé (cas signalé)", () => {
    expect(toInternationalDigits("0749693849", "225")).toBe("2250749693849");
    expect(toInternationalDigits("07 49 69 38 49", "225")).toBe("2250749693849");
  });
  it("Bénin : le 0 initial est conservé", () => {
    expect(toInternationalDigits("0129000000", "229")).toBe("2290129000000");
  });
  it("Sénégal, Nigeria, France : le 0 initial est retiré", () => {
    expect(toInternationalDigits("771234567", "221")).toBe("221771234567");
    expect(toInternationalDigits("08031234567", "234")).toBe("2348031234567");
    expect(toInternationalDigits("0612345678", "33")).toBe("33612345678");
  });
  it("numéro déjà international : inchangé, quel que soit le pays choisi", () => {
    expect(toInternationalDigits("+225 07 49 69 38 49", "234")).toBe("225074969384" + "9");
    expect(toInternationalDigits("00234 803 123 4567", "225")).toBe("2348031234567");
  });
  it("indicatif déjà présent sans « + » : pas de doublon", () => {
    expect(toInternationalDigits("2250749693849", "225")).toBe("2250749693849");
  });
  it("aucun pays choisi et numéro national : impossible à compléter", () => {
    expect(toInternationalDigits("0749693849", "")).toBeNull();
    expect(toInternationalDigits("0749693849", undefined)).toBeNull();
  });
  it("numéro vide : rien", () => {
    expect(toInternationalDigits("  ", "225")).toBeNull();
  });
  it("retrouve le pays d'un ancien indicatif enregistré", () => {
    expect(findCountryByDialCode("+225")?.iso).toBe("CI");
  });
});
