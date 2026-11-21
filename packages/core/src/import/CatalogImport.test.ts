import { schema } from "@gestion-boutique/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, useDevice, type TestDevice } from "../test/testDb";
import { getStockLevels } from "../services/StockService";
import { createProduct } from "../services/ProductsService";
import { buildCatalogTemplateCsv, loadExistingCatalogKeys, mapHeader, parseCsv, parseNumber, planCatalogImport, runCatalogImport } from "./catalogImport";

const none = () => ({ names: new Set<string>(), barcodes: new Set<string>() });

describe("lecture du CSV", () => {
  it("détecte le séparateur sur l'en-tête, gère guillemets et retours à la ligne", () => {
    expect(parseCsv("Nom;Prix\nRiz;500\n")).toEqual([["Nom", "Prix"], ["Riz", "500"]]);
    expect(parseCsv("Nom,Prix\r\nRiz,500\r\n")).toEqual([["Nom", "Prix"], ["Riz", "500"]]);
    expect(parseCsv("Nom\tPrix\nRiz\t500")).toEqual([["Nom", "Prix"], ["Riz", "500"]]);
    expect(parseCsv('Nom;Prix\n"Riz; long ""grain""";500\n"ligne1\nligne2";9')).toEqual([["Nom", "Prix"], ['Riz; long "grain"', "500"], ["ligne1\nligne2", "9"]]);
  });

  it("BOM ignoré, lignes vides écartées, dernière ligne sans retour", () => {
    expect(parseCsv("﻿Nom;Prix\n\n;;\nRiz;500")).toEqual([["Nom", "Prix"], ["Riz", "500"]]);
    expect(parseCsv("")).toEqual([]);
  });

  it("nombres à la française et à l'anglaise", () => {
    expect(parseNumber("1 500")).toBe(1500);
    expect(parseNumber("1 500")).toBe(1500); // espace insécable
    expect(parseNumber("1500,50")).toBe(1500.5);
    expect(parseNumber("1,500.50")).toBe(1500.5);
    expect(parseNumber("1.500,50")).toBe(1500.5);
    expect(parseNumber("2500 F")).toBe(2500);
    expect(parseNumber("12,5%")).toBe(12.5);
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("1,2,3")).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
  });

  it("reconnaît les en-têtes français et anglais, avec ou sans accent", () => {
    const m = mapHeader(["Désignation", "Prix de vente TTC", "Catégorie", "Code-barres", "Prix d'achat", "Qté", "Seuil d'alerte", "TVA", "Unité"]);
    expect(m).toMatchObject({ name: 0, salePrice: 1, category: 2, barcode: 3, purchasePrice: 4, stock: 5, lowStockThreshold: 6, taxRate: 7, unit: 8 });
    expect(mapHeader(["Product", "Price", "Cost"])).toMatchObject({ name: 0, salePrice: 1, purchasePrice: 2, category: -1 });
  });
});

describe("prévision de l'import", () => {
  it("crée, ignore les doublons (base et fichier), refuse les lignes invalides avec leur numéro", () => {
    const table = parseCsv(
      [
        "Nom;Prix de vente;Prix d'achat;Stock;Code-barres;Catégorie",
        "Riz 1kg;1 000;700;20;111;Épicerie",
        "RIZ 1KG;1000;;;;", // doublon du précédent (casse)
        "Sucre;500;;;111;", // même code-barres que Riz
        "Huile;;;;;", // prix manquant
        "Savon;abc;;;;", // prix illisible
        ";300;;;;", // nom manquant
        "Déjà là;300;;;;", // existe en base
        "Lait;-5;;;;", // prix négatif
        "Sel;200;;x;;", // stock illisible
        "Farine;800;;7,9;;", // stock arrondi
      ].join("\n"),
    );
    const plan = planCatalogImport(table, { names: new Set(["deja la"]), barcodes: new Set() });
    expect(plan.headerError).toBeNull();
    expect(plan.toCreate.map((r) => [r.line, r.name, r.salePrice, r.purchasePrice, r.stock])).toEqual([[2, "Riz 1kg", 1000, 700, 20], [11, "Farine", 800, 0, 7]]);
    expect(plan.duplicates.map((d) => d.line)).toEqual([3, 4, 8]);
    expect(plan.errors.map((e) => e.line)).toEqual([5, 6, 7, 9, 10]);
    expect(plan.errors[0]!.message).toContain("prix");
    expect(plan.recognized).toEqual(expect.arrayContaining(["name", "salePrice", "stock", "barcode", "category"]));
  });

  it("refuse un fichier sans colonne nom ou sans colonne prix, vide, ou trop long", () => {
    expect(planCatalogImport([], none()).headerError).not.toBeNull();
    expect(planCatalogImport([["Prix"], ["5"]], none()).headerError).toContain("Nom");
    expect(planCatalogImport([["Nom"], ["Riz"]], none()).headerError).toContain("Prix");
    const big = [["Nom", "Prix"], ...Array.from({ length: 5001 }, (_, i) => [`P${i}`, "1"])];
    expect(planCatalogImport(big, none()).headerError).not.toBeNull();
    expect(planCatalogImport(big.slice(0, 5001), none()).headerError).toBeNull();
  });

  it("un nom de plus de 120 caractères est refusé ; une TVA hors 0-100 aussi", () => {
    const plan = planCatalogImport([["Nom", "Prix", "TVA"], ["x".repeat(121), "1", ""], ["Ok", "1", "150"], ["Ok2", "1", "18"]], none());
    expect(plan.errors.map((e) => e.line)).toEqual([2, 3]);
    expect(plan.toCreate.map((r) => [r.name, r.taxRate])).toEqual([["Ok2", 18]]);
  });
});

describe("import réel", () => {
  let device: TestDevice;
  let biz: SeededBusiness;
  beforeAll(async () => {
    device = await createDevice("import");
    biz = await seedBusiness(device.db!);
  });
  afterAll(releaseDevices);

  it("crée produits, catégories et stock de départ, sans doublon à la relance", async () => {
    useDevice(device);
    await createProduct(device.db!, { name: "Déjà là", purchasePrice: 1, salePrice: 2, createdBy: biz.admin.id }, biz.admin.permissions);
    const csv = ["Nom;Catégorie;Unité;Prix de vente;Prix d'achat;Stock;Code-barres", "Riz;Épicerie;kg;1000;700;20;6001", "Sucre;épicerie;kg;500;;;6002", "Déjà là;;;9;;;", "Huile;Épicerie;litre;1500;1100;5;6003"].join("\n");
    const plan = planCatalogImport(parseCsv(csv), await loadExistingCatalogKeys(device.db!));
    expect(plan.toCreate.length).toBe(3);
    expect(plan.duplicates.length).toBe(1);

    const result = await runCatalogImport(device.db!, plan.toCreate, { userId: biz.admin.id, permissions: biz.admin.permissions, stockLocationId: biz.locations.surface });
    expect(result).toEqual({ created: 3, stockAdded: 2, failed: [] });

    const categories = await device.db!.select().from(schema.categories);
    expect(categories.map((c) => c.name)).toEqual(["Épicerie"]); // « épicerie » en minuscule réutilise la même
    const products = await device.db!.select().from(schema.products);
    expect(products.map((p) => p.name).sort()).toEqual(["Déjà là", "Huile", "Riz", "Sucre"]);
    const riz = products.find((p) => p.name === "Riz")!;
    expect(riz).toMatchObject({ salePrice: 1000, purchasePrice: 700, unit: "kg" });
    const variants = await device.db!.select().from(schema.productVariants);
    expect(variants.find((v) => v.productId === riz.id)?.barcode).toBe("6001");
    const levels = await getStockLevels(device.db!, biz.storeId);
    expect(levels.filter((l) => l.variantId === variants.find((v) => v.productId === riz.id)!.id).reduce((n, l) => n + l.quantity, 0)).toBe(20);

    // Relancé tel quel : tout est reconnu comme déjà présent.
    const again = planCatalogImport(parseCsv(csv), await loadExistingCatalogKeys(device.db!));
    expect(again.toCreate).toEqual([]);
    expect(again.duplicates.length).toBe(4);
  });

  it("un produit refusé par le service n'arrête pas les suivants et est rapporté avec sa ligne", async () => {
    useDevice(device);
    const rows = planCatalogImport(parseCsv("Nom;Prix;TVA\nBon;100;\nMauvais;100;18\nAutre;50;"), none()).toCreate;
    rows[1]!.salePrice = Number.NaN; // une valeur que le service refuse
    const result = await runCatalogImport(device.db!, rows, { userId: biz.admin.id, permissions: biz.admin.permissions, stockLocationId: null });
    expect(result.created).toBe(2);
    expect(result.failed.map((f) => f.line)).toEqual([3]);
  });

  it("un utilisateur sans droit sur les produits ne crée rien", async () => {
    useDevice(device);
    const rows = planCatalogImport(parseCsv("Nom;Prix\nInterdit;100"), none()).toCreate;
    const result = await runCatalogImport(device.db!, rows, { userId: biz.cashier.id, permissions: biz.cashier.permissions, stockLocationId: null });
    expect(result.created).toBe(0);
    expect(result.failed.length).toBe(1);
  });
});

describe("modèle de catalogue", () => {
  it("s'ouvre dans Excel (BOM, séparateur ;) et se relit par l'import", () => {
    const csv = buildCatalogTemplateCsv([{ name: "Baguette", category: "Pains", unit: "unité" }, { name: 'Pain "complet"; bio', category: "Pains" }]);
    expect(csv.startsWith("﻿")).toBe(true);
    const table = parseCsv(csv);
    expect(table[0]).toEqual(["Nom", "Catégorie", "Unité", "Prix de vente", "Prix d'achat", "Stock", "Code-barres"]);
    expect(table[2]![0]).toBe('Pain "complet"; bio');
    // Sans prix, les lignes du modèle sont refusées avec un message clair (le commerçant doit les remplir).
    const plan = planCatalogImport(table, none());
    expect(plan.headerError).toBeNull();
    expect(plan.toCreate).toEqual([]);
    expect(plan.errors.length).toBe(2);
    expect(plan.errors[0]!.message).toContain("prix");
  });
});
