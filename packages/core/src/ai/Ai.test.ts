import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, useDevice, type TestDevice } from "../test/testDb";
import { createProduct } from "../services/ProductsService";
import { createSale } from "../services/SalesService";
import { addManualStockEntry } from "../services/StockService";
import { createExpense } from "../services/ExpensesService";
import { ASSISTANT_SYSTEM_PROMPT, buildAssistantContext, buildAssistantUserMessage } from "./assistantContext";
import { matchDeliveryLines, nameSimilarity, sanitizeDeliveryLines } from "./productMatch";

describe("rapprochement des lignes d'un bon de livraison", () => {
  const catalog = [
    { id: 1, name: "Riz parfumé 1kg" },
    { id: 2, name: "Huile végétale 1 L" },
    { id: 3, name: "Sucre en poudre 1kg" },
    { id: 4, name: "Chocolat au lait" },
  ];

  it("ressemblance : accents, casse, mots vides, débuts de mots", () => {
    expect(nameSimilarity("RIZ PARFUME 1KG", "Riz parfumé 1kg")).toBe(1);
    expect(nameSimilarity("Choco lait", "Chocolat au lait")).toBe(1);
    expect(nameSimilarity("Sac de riz", "Riz parfumé 1kg")).toBeLessThan(0.7);
    expect(nameSimilarity("", "Riz")).toBe(0);
    expect(nameSimilarity("Savon", "Riz parfumé 1kg")).toBe(0);
  });

  it("rapproche les bonnes lignes, laisse sans produit ce qui ne ressemble à rien", () => {
    const matches = matchDeliveryLines(
      [
        { name: "RIZ PARFUME 1KG", quantity: 20, unitCost: 600 },
        { name: "Huile vegetale 1L", quantity: 10, unitCost: 1100 },
        { name: "Savon de Marseille", quantity: 5, unitCost: 300 },
        { name: "Sucre poudre", quantity: 8, unitCost: null },
      ],
      catalog,
    );
    expect(matches.map((m) => m.product?.id ?? null)).toEqual([1, 2, null, 3]);
    expect(matches[2]!.score).toBeLessThan(0.6);
  });

  it("un seuil plus strict refuse les rapprochements approximatifs", () => {
    const loose = matchDeliveryLines([{ name: "Sucre", quantity: 1, unitCost: null }], catalog, 0.3);
    const strict = matchDeliveryLines([{ name: "Sucre", quantity: 1, unitCost: null }], catalog, 0.9);
    expect(loose[0]!.product?.id).toBe(3);
    expect(strict[0]!.product).toBeNull();
  });

  it("valide la réponse de l'IA : lignes plausibles seulement", () => {
    const lines = sanitizeDeliveryLines({
      lines: [
        { name: "  Riz  ", quantity: 20, unitCost: 600 },
        { name: "", quantity: 5 },
        { name: "Négatif", quantity: -3 },
        { name: "Absurde", quantity: 1e9 },
        { name: "Texte", quantity: "beaucoup" },
        { name: "Sans coût", quantity: 2.5, unitCost: null },
        { name: "Coût négatif", quantity: 1, unitCost: -5 },
        { name: "x".repeat(300), quantity: 1 },
      ],
    });
    expect(lines.map((l) => [l.name.slice(0, 12), l.quantity, l.unitCost])).toEqual([["Riz", 20, 600], ["Sans coût", 2.5, null], ["Coût négatif", 1, null], ["x".repeat(12), 1, null]]);
    expect(lines[3]!.name.length).toBe(120);
    expect(sanitizeDeliveryLines(null)).toEqual([]);
    expect(sanitizeDeliveryLines({ lines: "pas une liste" })).toEqual([]);
    expect(sanitizeDeliveryLines({ lines: Array.from({ length: 500 }, (_, i) => ({ name: `P${i}`, quantity: 1 })) }).length).toBe(200);
  });
});

describe("contexte de l'assistant : aucun nom de client ni d'employé", () => {
  let device: TestDevice;
  let biz: SeededBusiness;

  beforeAll(async () => {
    device = await createDevice("assistant");
    biz = await seedBusiness(device.db!);
    const p = await createProduct(device.db!, { name: "Riz parfumé", purchasePrice: 600, salePrice: 1000, lowStockThreshold: 50, createdBy: biz.admin.id }, biz.admin.permissions);
    await addManualStockEntry(device.db!, { variantId: p.defaultVariant.id, locationId: biz.locations.surface, quantity: 30, note: "départ", userId: biz.admin.id }, biz.admin.permissions);
    const sale = (qty: number, extra: Record<string, unknown> = {}) =>
      createSale(device.db!, { userId: biz.cashier.id, saleMode: "pos", items: [{ variantId: p.defaultVariant.id, quantity: qty, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId, ...extra }, biz.admin.permissions);
    await sale(2);
    await sale(1, { paymentMethod: "credit", amountPaid: 0, newCustomerName: "Awa Secrète Koné" });
    await createExpense(device.db!, { category: "Loyer", amount: 1, expenseDate: "2026-01-01", userId: biz.admin.id }, biz.admin.permissions);
  });
  afterAll(releaseDevices);

  it("résume ventes, produits, stock bas et créances", async () => {
    useDevice(device);
    const context = await buildAssistantContext(device.db!);
    expect(context.salesToday).toEqual({ count: 2, total: 3000 });
    expect(context.salesLast30Days.total).toBe(3000);
    expect(context.topProducts30Days[0]).toMatchObject({ name: "Riz parfumé", quantity: 3 });
    expect(context.lowStock).toEqual([{ name: "Riz parfumé", stock: 27, threshold: 50 }]);
    expect(context.openCredits).toEqual({ count: 1, totalRemaining: 1000 });
    expect(context.currency).toBe("XOF");
    expect(context.salesByDay.length).toBe(1);
  });

  it("le texte envoyé ne contient ni client, ni employé, ni téléphone", async () => {
    useDevice(device);
    const message = buildAssistantUserMessage(await buildAssistantContext(device.db!), "  Combien ai-je vendu aujourd'hui ?  ");
    for (const secret of ["Awa", "Secrète", "Koné", "Caissier", "Gérant", "Admin", "motdepasse", "phone", "téléphone"]) expect(message).not.toContain(secret);
    expect(message).toContain("Combien ai-je vendu aujourd'hui ?");
    expect(message).toContain("Riz parfumé");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("N'invente aucun chiffre");
  });

  it("une question trop longue est tronquée", async () => {
    useDevice(device);
    const message = buildAssistantUserMessage(await buildAssistantContext(device.db!), "a".repeat(5000));
    expect(message.length).toBeLessThan(5000);
  });
});
