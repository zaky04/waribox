import { CURRENCY_PRESETS } from "@gestion-boutique/i18n";
import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, updateUser, verifyPassword } from "../auth/AuthService";
import { cleanProductImage, MAX_PRODUCT_IMAGE_CHARS } from "../domain/productImage";
import { breakdownChange, spokenAmount } from "../domain/simpleCash";
import { applyCatalogSnapshot, buildCatalogSnapshot } from "../sync/snapshot";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, useDevice, type TestDevice } from "../test/testDb";
import { createProduct, updateProduct } from "./ProductsService";

// Caisse simplifiée : rendu de monnaie en images, vignette produit, employé « assisté ».

const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";

describe("rendu de monnaie en billets et pièces", () => {
  const xof = [10000, 5000, 2000, 1000, 500, 250, 200, 100, 50, 25, 10, 5];

  it("décompose du plus grand au plus petit", () => {
    expect(breakdownChange(3750, xof)).toEqual({ parts: [{ value: 2000, count: 1 }, { value: 1000, count: 1 }, { value: 500, count: 1 }, { value: 250, count: 1 }], rest: 0 });
    expect(breakdownChange(12000, xof).parts).toEqual([{ value: 10000, count: 1 }, { value: 2000, count: 1 }]);
    expect(breakdownChange(25000, xof).parts).toEqual([{ value: 10000, count: 2 }, { value: 5000, count: 1 }]);
  });

  it("rien à rendre, montant négatif ou invalide", () => {
    expect(breakdownChange(0, xof)).toEqual({ parts: [], rest: 0 });
    expect(breakdownChange(-50, xof)).toEqual({ parts: [], rest: 0 });
  });

  it("un reste plus fin que la plus petite pièce est renvoyé à part", () => {
    expect(breakdownChange(3, xof)).toEqual({ parts: [], rest: 3 });
    expect(breakdownChange(12, xof)).toEqual({ parts: [{ value: 10, count: 1 }], rest: 2 });
  });

  it("ignore l'ordre et les doublons des coupures, sans dérive de flottants", () => {
    expect(breakdownChange(0.3, [0.1, 0.2, 0.1, 0]).parts).toEqual([{ value: 0.2, count: 1 }, { value: 0.1, count: 1 }]);
    expect(breakdownChange(0.3, [0.1, 0.2]).rest).toBe(0);
    expect(breakdownChange(7, [1, 5, 2]).parts).toEqual([{ value: 5, count: 1 }, { value: 2, count: 1 }]);
  });

  it("chaque devise : les montants rapides se rendent exactement, coupures triées", () => {
    for (const preset of CURRENCY_PRESETS) {
      expect(preset.denominations, preset.code).toEqual([...preset.denominations].sort((a, b) => b - a));
      for (const quick of preset.cashQuickAmounts) expect(breakdownChange(quick, preset.denominations).rest, `${preset.code} ${quick}`).toBe(0);
      expect(preset.spokenName.fr.length, preset.code).toBeGreaterThan(0);
      expect(preset.spokenName.en.length, preset.code).toBeGreaterThan(0);
    }
  });
});

describe("montant dit à voix haute", () => {
  const xof = CURRENCY_PRESETS.find((c) => c.code === "XOF")!;
  const eur = CURRENCY_PRESETS.find((c) => c.code === "EUR")!;
  it("sans séparateur de milliers, virgule en français, point en anglais", () => {
    expect(spokenAmount(2500, "fr", xof)).toBe("2500 francs CFA");
    expect(spokenAmount(2500, "en", xof)).toBe("2500 CFA francs");
    expect(spokenAmount(12.5, "fr", eur)).toBe("12,5 euros");
    expect(spokenAmount(12.5, "en", eur)).toBe("12.5 euros");
    expect(spokenAmount(0.1 + 0.2, "fr", eur)).toBe("0,3 euros");
    expect(spokenAmount(1234567, "fr", xof)).toBe("1234567 francs CFA");
  });
  it("chaque devise a un seuil pièce/billet cohérent avec ses coupures", () => {
    for (const c of CURRENCY_PRESETS) {
      expect(c.denominations.some((d) => d > c.coinsUpTo), c.code).toBe(true); // au moins un billet
      expect(c.denominations.some((d) => d <= c.coinsUpTo), c.code).toBe(true); // au moins une pièce
    }
  });
});

describe("vignette produit", () => {
  it("accepte une petite image, vide = pas de photo", () => {
    expect(cleanProductImage(JPEG)).toBe(JPEG);
    expect(cleanProductImage("  ")).toBeNull();
    expect(cleanProductImage(null)).toBeNull();
    expect(cleanProductImage(undefined)).toBeNull();
  });

  it("refuse une image trop lourde, un autre format ou du contenu actif", () => {
    expect(() => cleanProductImage("data:image/jpeg;base64," + "A".repeat(MAX_PRODUCT_IMAGE_CHARS))).toThrow();
    expect(() => cleanProductImage("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toThrow();
    expect(() => cleanProductImage("data:text/html;base64,PHNjcmlwdD4=")).toThrow();
    expect(() => cleanProductImage("https://exemple.com/a.jpg")).toThrow();
    expect(() => cleanProductImage("data:image/png;base64,AAAA\"onload=alert(1)")).toThrow();
  });
});

describe("services : photo produit et employé assisté", () => {
  let master: TestDevice;
  let biz: SeededBusiness;

  beforeAll(async () => {
    master = await createDevice("simple-master");
    biz = await seedBusiness(master.db!);
  });
  afterAll(releaseDevices);

  it("la photo est enregistrée, remplacée, retirée, et une photo invalide est refusée", async () => {
    useDevice(master);
    const { product } = await createProduct(master.db!, { name: "Riz", purchasePrice: 100, salePrice: 150, imageDataUrl: JPEG, createdBy: biz.admin.id }, biz.admin.permissions);
    expect(product.imageDataUrl).toBe(JPEG);
    const read = async () => (await master.db!.select().from(schema.products).where(eq(schema.products.id, product.id)).get())!.imageDataUrl;

    await updateProduct(master.db!, product.id, { name: "Riz long", updatedBy: biz.admin.id }, biz.admin.permissions);
    expect(await read()).toBe(JPEG); // une modification sans photo ne l'efface pas

    await expect(updateProduct(master.db!, product.id, { imageDataUrl: "data:image/svg+xml;base64,AAAA" }, biz.admin.permissions)).rejects.toThrow();
    expect(await read()).toBe(JPEG);

    await updateProduct(master.db!, product.id, { imageDataUrl: null }, biz.admin.permissions);
    expect(await read()).toBeNull();
    await expect(createProduct(master.db!, { name: "X", purchasePrice: 1, salePrice: 2, imageDataUrl: "pas une image" }, biz.admin.permissions)).rejects.toThrow();
  });

  it("la photo est copiée sur un appareil relié avec le catalogue", async () => {
    useDevice(master);
    await createProduct(master.db!, { name: "Huile", purchasePrice: 100, salePrice: 150, imageDataUrl: JPEG, createdBy: biz.admin.id }, biz.admin.permissions);
    const snapshot = await buildCatalogSnapshot(master.db!, {});
    const worker = await createDevice("simple-worker");
    useDevice(worker);
    await applyCatalogSnapshot(worker.db!, snapshot);
    const copied = (await worker.db!.select().from(schema.products)).find((p) => p.name === "Huile");
    expect(copied?.imageDataUrl).toBe(JPEG);
    useDevice(master);
  });

  it("l'employé assisté : réglage créé, lu à la connexion, modifiable, faux par défaut", async () => {
    useDevice(master);
    expect(biz.cashier.simpleCashOnly).toBe(false);
    const created = await createUser(
      master.db!,
      { fullName: "Assisté", username: "assiste", password: "motdepasse-assiste", roleId: biz.roles.caissier, storeId: biz.storeId, simpleCashOnly: true },
      biz.admin.permissions,
    );
    expect(created.simpleCashOnly).toBe(true);
    expect((await verifyPassword(master.db!, "assiste", "motdepasse-assiste"))?.simpleCashOnly).toBe(true);
    const updated = await updateUser(master.db!, created.id, { simpleCashOnly: false }, biz.admin.permissions);
    expect(updated.simpleCashOnly).toBe(false);
    // Une modification sans ce champ ne le change pas.
    await updateUser(master.db!, created.id, { simpleCashOnly: true }, biz.admin.permissions);
    expect((await updateUser(master.db!, created.id, { fullName: "Assisté 2" }, biz.admin.permissions)).simpleCashOnly).toBe(true);
  });
});
