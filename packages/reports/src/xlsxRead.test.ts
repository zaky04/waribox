import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { readXlsxFirstSheet, XlsxReadError } from "./xlsxRead";
import { buildXlsxBytes } from "./xlsxWriter";

// SheetJS ne sert qu'à PRODUIRE des fichiers « comme Excel » (archive compressée, chaînes partagées) pour
// vérifier que notre lecteur les comprend, en plus de ce que notre propre écrivain sait relire.

function sheetJsFile(rows: unknown[][], extraSheet = false): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Catalogue");
  if (extraSheet) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["autre"], ["feuille"]]), "Autre");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

describe("lecteur .xlsx", () => {
  it("relit un fichier de type Excel (compressé, chaînes partagées, accents, nombres, vides)", async () => {
    const rows = [
      ["Nom", "Prix de vente", "Stock", "Catégorie"],
      ["Riz parfumé 1kg", 1000, 20, "Épicerie"],
      ["Huile \"d'olive\" & co <bio>", 1500.5, "", "Épicerie"],
      ["", 300, 5, ""],
      ["Dernière", 12, 0, "Émoji ✓"],
    ];
    const table = await readXlsxFirstSheet(sheetJsFile(rows));
    expect(table).toEqual([
      ["Nom", "Prix de vente", "Stock", "Catégorie"],
      ["Riz parfumé 1kg", "1000", "20", "Épicerie"],
      ["Huile \"d'olive\" & co <bio>", "1500.5", "", "Épicerie"],
      ["", "300", "5", ""],
      ["Dernière", "12", "0", "Émoji ✓"],
    ]);
  });

  it("ne lit que la première feuille", async () => {
    expect(await readXlsxFirstSheet(sheetJsFile([["a"], ["b"]], true))).toEqual([["a"], ["b"]]);
  });

  it("relit ce que l'écrivain maison produit", async () => {
    const bytes = buildXlsxBytes([{ name: "Feuille", rows: [{ Nom: "Sucre", Prix: 500 }, { Nom: "Sel", Prix: 200.25 }] }]);
    expect(await readXlsxFirstSheet(bytes)).toEqual([["Nom", "Prix"], ["Sucre", "500"], ["Sel", "200.25"]]);
  });

  it("les lignes entièrement vides sont écartées, les trous de colonnes comblés", async () => {
    const table = await readXlsxFirstSheet(sheetJsFile([["A", null, "C"], [], [null, "x"]]));
    expect(table).toEqual([["A", "", "C"], ["", "x"]]);
  });

  it("refuse proprement ce qui n'est pas un classeur", async () => {
    await expect(readXlsxFirstSheet(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(XlsxReadError);
    await expect(readXlsxFirstSheet(new TextEncoder().encode("Nom;Prix\nRiz;5"))).rejects.toBeInstanceOf(XlsxReadError);
    await expect(readXlsxFirstSheet(new Uint8Array())).rejects.toBeInstanceOf(XlsxReadError);
    const good = sheetJsFile([["a"]]);
    await expect(readXlsxFirstSheet(good.slice(0, good.length - 30))).rejects.toBeInstanceOf(XlsxReadError); // tronqué
  });
});
