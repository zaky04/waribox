import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildXlsxBytes, columnLetters, sanitizeSheetName } from "./xlsxWriter";

// SheetJS n'est plus qu'un outil de TEST : il relit ce que l'écrivain maison produit, ce qui
// vérifie que le fichier est un vrai classeur lisible par une implémentation indépendante.
function read(bytes: Uint8Array) {
  return XLSX.read(bytes, { type: "array" });
}

describe("écrivain .xlsx", () => {
  it("relit exactement ce qui a été écrit (textes, nombres, plusieurs onglets, accents)", () => {
    const bytes = buildXlsxBytes([
      { name: "Résumé", rows: [{ Période: "2026-03-01 → 2026-03-31", "Chiffre d'affaires": 1234567.5, Ventes: 42 }] },
      { name: "Par jour", rows: [{ Date: "2026-03-01", Total: 1000 }, { Date: "2026-03-02", Total: 0 }, { Date: "2026-03-03", Total: -250.25 }] },
    ]);
    const wb = read(bytes);
    expect(wb.SheetNames).toEqual(["Résumé", "Par jour"]);
    expect(XLSX.utils.sheet_to_json(wb.Sheets["Résumé"]!)).toEqual([{ Période: "2026-03-01 → 2026-03-31", "Chiffre d'affaires": 1234567.5, Ventes: 42 }]);
    expect(XLSX.utils.sheet_to_json(wb.Sheets["Par jour"]!)).toEqual([
      { Date: "2026-03-01", Total: 1000 },
      { Date: "2026-03-02", Total: 0 },
      { Date: "2026-03-03", Total: -250.25 },
    ]);
  });

  it("les nombres restent des nombres (sommables dans Excel), les textes des textes", () => {
    const wb = read(buildXlsxBytes([{ name: "T", rows: [{ a: 12, b: "12", c: true }] }]));
    const sheet = wb.Sheets["T"]!;
    expect(sheet["A2"]!.t).toBe("n");
    expect(sheet["B2"]!.t).toBe("s");
    expect(sheet["C2"]!.t).toBe("b");
  });

  it("échappe le XML et supprime les caractères de contrôle interdits", () => {
    const wb = read(buildXlsxBytes([{ name: "T", rows: [{ nom: `<b>Tom & "Jerry"</b>\u0001 fin` }] }]));
    expect(XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets["T"]!)[0]!.nom).toBe(`<b>Tom & "Jerry"</b> fin`);
  });

  it("garde les espaces de début et de fin et les retours à la ligne", () => {
    const wb = read(buildXlsxBytes([{ name: "T", rows: [{ nom: "  deux espaces\nligne 2  " }] }]));
    expect(XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets["T"]!)[0]!.nom).toBe("  deux espaces\nligne 2  ");
  });

  it("union des colonnes dans l'ordre d'apparition, cellules manquantes vides", () => {
    const wb = read(buildXlsxBytes([{ name: "T", rows: [{ a: 1 }, { a: 2, b: "x" }, { c: 3 }] }]));
    expect(XLSX.utils.sheet_to_json(wb.Sheets["T"]!, { header: 1 })).toEqual([["a", "b", "c"], [1], [2, "x"], [undefined, undefined, 3]]);
  });

  it("un onglet sans ligne ou aucun onglet donne quand même un classeur valide", () => {
    expect(read(buildXlsxBytes([{ name: "Vide", rows: [] }])).SheetNames).toEqual(["Vide"]);
    expect(read(buildXlsxBytes([])).SheetNames).toHaveLength(1);
  });

  it("beaucoup de lignes et de colonnes (au-delà de Z) restent exactes", () => {
    const row = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`col${i}`, i]));
    const rows = Array.from({ length: 2000 }, (_, r) => ({ ...row, col0: r }));
    const wb = read(buildXlsxBytes([{ name: "Gros", rows }]));
    const back = XLSX.utils.sheet_to_json<Record<string, number>>(wb.Sheets["Gros"]!);
    expect(back).toHaveLength(2000);
    expect(back[1999]!.col0).toBe(1999);
    expect(back[0]!.col29).toBe(29);
  });

  it("noms d'onglet : caractères interdits retirés, 31 caractères, doublons distingués", () => {
    const taken = new Set<string>();
    expect(sanitizeSheetName("Ventes/Marges: [2026]?", taken)).toBe("Ventes Marges   2026");
    expect(sanitizeSheetName("x".repeat(40), taken)).toHaveLength(31);
    expect(sanitizeSheetName("Ventes/Marges: [2026]?", taken)).toBe("Ventes Marges   2026 (2)");
    expect(sanitizeSheetName("", taken)).toBe("Feuille");
    const wb = read(buildXlsxBytes([{ name: "Même", rows: [{ a: 1 }] }, { name: "même", rows: [{ a: 2 }] }]));
    expect(wb.SheetNames).toEqual(["Même", "même (2)"]);
  });

  it("lettres de colonne", () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnLetters)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
  });

  it("l'archive est un vrai ZIP (signature, somme de contrôle exacte)", () => {
    const bytes = buildXlsxBytes([{ name: "T", rows: [{ a: 1 }] }]);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // SheetJS vérifie les CRC à la lecture ; une archive corrompue lèverait ici.
    expect(() => read(bytes)).not.toThrow();
  });
});
