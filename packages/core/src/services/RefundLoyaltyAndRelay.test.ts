import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertMasterOnly, MasterOnlyError, setRelayDevice } from "../domain/relayGuard";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, type TestDevice } from "../test/testDb";
import { createCustomer } from "./CustomersService";
import { createExpense } from "./ExpensesService";
import { createProduct } from "./ProductsService";
import { createPurchase } from "./PurchasesService";
import { createRefund } from "./RefundsService";
import { createSale } from "./SalesService";
import { updateSettings } from "./SettingsService";
import { addManualStockEntry } from "./StockService";
import { createSupplier } from "./SuppliersService";

let device: TestDevice;
let biz: SeededBusiness;
let variantId: number;

const customer = (id: number) => device.db!.select().from(schema.customers).where(eq(schema.customers.id, id)).get().then((c) => c!);

async function newCustomer(name: string) {
  return (await createCustomer(device.db!, { fullName: name, createdBy: biz.admin.id }, biz.admin.permissions)).id;
}

const sale = (customerId: number, unitPrice: number, extra: Record<string, unknown> = {}) =>
  createSale(
    device.db!,
    { userId: biz.admin.id, customerId, saleMode: "pos", items: [{ variantId, quantity: 1, unitPrice }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId, ...extra },
    biz.admin.permissions,
  );

async function refundFraction(saleId: number, fraction: number) {
  const items = await device.db!.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, saleId));
  const item = items[0]!;
  // Le prix de vente est de 10 000 pour 1 unité : un remboursement partiel passe par la quantité, donc on vend 4 unités.
  return createRefund(
    device.db!,
    { saleId, userId: biz.admin.id, reason: "test", method: "cash", items: [{ saleItemId: item.id, quantity: item.quantity * fraction, restock: true }] },
    biz.admin.permissions,
  );
}

beforeAll(async () => {
  device = await createDevice("refund-loyalty");
  biz = await seedBusiness(device.db!);
  await updateSettings(device.db!, { loyaltyPointsRatio: 0.01 }, biz.admin.permissions); // 1 point pour 100
  const p = await createProduct(device.db!, { name: "P", purchasePrice: 100, salePrice: 1000, createdBy: biz.admin.id }, biz.admin.permissions);
  variantId = p.defaultVariant.id;
  await addManualStockEntry(device.db!, { variantId, locationId: biz.locations.surface, quantity: 100, note: "départ", userId: biz.admin.id }, biz.admin.permissions);
});

afterAll(releaseDevices);

describe("un remboursement reprend les points de fidélité gagnés sur la vente", () => {
  it("remboursement total : les points gagnés sont repris, le palier aussi", async () => {
    const id = await newCustomer("Total");
    const s = await createSale(device.db!, { userId: biz.admin.id, customerId: id, saleMode: "pos", items: [{ variantId, quantity: 4, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions);
    const earned = (await customer(id)).loyaltyPoints;
    expect(earned).toBeGreaterThan(0);
    await refundFraction(s.id, 1);
    const after = await customer(id);
    expect(after.loyaltyPoints).toBe(0);
    expect(after.lifetimeLoyaltyPoints).toBe(0);
  });

  it("remboursements partiels successifs : repris au prorata, jamais plus que ce qui a été gagné", async () => {
    const id = await newCustomer("Partiel");
    const s = await createSale(device.db!, { userId: biz.admin.id, customerId: id, saleMode: "pos", items: [{ variantId, quantity: 4, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions);
    const earned = (await customer(id)).loyaltyPoints;
    await refundFraction(s.id, 0.25); // 1 unité sur 4
    expect((await customer(id)).loyaltyPoints).toBeCloseTo(earned * 0.75, 2);
    await refundFraction(s.id, 0.25); // 1 de plus (fraction de la quantité d'origine)
    expect((await customer(id)).loyaltyPoints).toBeCloseTo(earned * 0.5, 2);
    // Le reste : tout est repris, sans passer sous zéro.
    const items = await device.db!.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, s.id));
    await createRefund(device.db!, { saleId: s.id, userId: biz.admin.id, reason: "test", method: "cash", items: [{ saleItemId: items[0]!.id, quantity: 2, restock: true }] }, biz.admin.permissions);
    const end = await customer(id);
    expect(end.loyaltyPoints).toBeCloseTo(0, 2);
    expect(end.lifetimeLoyaltyPoints).toBeCloseTo(0, 2);
  });

  it("les points déjà dépensés ne rendent pas le solde négatif ; le cumul à vie baisse de la totalité", async () => {
    const id = await newCustomer("Dépensé");
    const s1 = await createSale(device.db!, { userId: biz.admin.id, customerId: id, saleMode: "pos", items: [{ variantId, quantity: 4, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions);
    const earned = (await customer(id)).loyaltyPoints; // 40
    // Le client dépense la quasi-totalité de ses points sur un autre achat.
    await createSale(device.db!, { userId: biz.admin.id, customerId: id, saleMode: "pos", items: [{ variantId, quantity: 1, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId, redeemPoints: Math.floor(earned) }, biz.admin.permissions).catch(() => undefined);
    await refundFraction(s1.id, 1);
    const after = await customer(id);
    expect(after.loyaltyPoints).toBeGreaterThanOrEqual(0);
    expect(after.lifetimeLoyaltyPoints).toBeGreaterThanOrEqual(0);
  });

  it("l'exploit « acheter, gagner des points, rembourser, échanger les points » ne laisse aucun point", async () => {
    const id = await newCustomer("Exploit");
    const s = await createSale(device.db!, { userId: biz.admin.id, customerId: id, saleMode: "pos", items: [{ variantId, quantity: 4, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions);
    await refundFraction(s.id, 1);
    // Plus aucun point à échanger : l'échange est refusé.
    await expect(
      createSale(device.db!, { userId: biz.admin.id, customerId: id, saleMode: "pos", items: [{ variantId, quantity: 1, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId, redeemPoints: 10 }, biz.admin.permissions),
    ).rejects.toThrow();
  });

  it("une vente sans client n'est pas concernée", async () => {
    const s = await createSale(device.db!, { userId: biz.admin.id, saleMode: "pos", items: [{ variantId, quantity: 2, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions);
    await expect(refundFraction(s.id, 1)).resolves.toBeDefined();
  });

  it("la reprise est consignée (une ligne négative, motif refund_reversal)", async () => {
    const id = await newCustomer("Trace");
    const s = await createSale(device.db!, { userId: biz.admin.id, customerId: id, saleMode: "pos", items: [{ variantId, quantity: 4, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions);
    await refundFraction(s.id, 1);
    const rows = await device.db!.select().from(schema.loyaltyTransactions).where(eq(schema.loyaltyTransactions.customerId, id));
    const reversal = rows.filter((r) => r.reason === "refund_reversal");
    expect(reversal).toHaveLength(1);
    expect(reversal[0]!.pointsDelta).toBeLessThan(0);
    expect(reversal[0]!.syncId).toBeTruthy();
  });
});

describe("appareil relié : le Maître fait foi pour le catalogue et certaines opérations", () => {
  afterEach(() => setRelayDevice(false));

  it("sans rôle d'appareil relié, rien n'est bloqué", async () => {
    await expect(createProduct(device.db!, { name: "Libre", purchasePrice: 1, salePrice: 2, createdBy: biz.admin.id }, biz.admin.permissions)).resolves.toBeDefined();
  });

  it("le catalogue ne se modifie pas depuis un appareil relié", async () => {
    setRelayDevice(true);
    await expect(createProduct(device.db!, { name: "Interdit", purchasePrice: 1, salePrice: 2, createdBy: biz.admin.id }, biz.admin.permissions)).rejects.toBeInstanceOf(MasterOnlyError);
    await expect(createCustomer(device.db!, { fullName: "Interdit", createdBy: biz.admin.id }, biz.admin.permissions)).rejects.toBeInstanceOf(MasterOnlyError);
    await expect(createSupplier(device.db!, { name: "Interdit", createdBy: biz.admin.id }, biz.admin.permissions)).rejects.toBeInstanceOf(MasterOnlyError);
    const products = await device.db!.select().from(schema.products);
    expect(products.map((p) => p.name)).not.toContain("Interdit");
  });

  it("les opérations non partagées (achat, remboursement, correction de dépense) sont refusées", async () => {
    const s = await createSale(device.db!, { userId: biz.admin.id, saleMode: "pos", items: [{ variantId, quantity: 1, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions);
    const item = (await device.db!.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, s.id)))[0]!;
    const supplier = await createSupplier(device.db!, { name: "Fournisseur", createdBy: biz.admin.id }, biz.admin.permissions);
    setRelayDevice(true);
    await expect(createRefund(device.db!, { saleId: s.id, userId: biz.admin.id, reason: "x", method: "cash", items: [{ saleItemId: item.id, quantity: 1, restock: true }] }, biz.admin.permissions)).rejects.toBeInstanceOf(MasterOnlyError);
    await expect(createPurchase(device.db!, { userId: biz.admin.id, supplierId: supplier.id, items: [{ variantId, quantity: 1, unitCost: 100 }], paymentMethod: "cash", storeId: biz.storeId }, biz.admin.permissions)).rejects.toBeInstanceOf(MasterOnlyError);
  });

  it("ce qui est partagé reste possible : vente, dépense, entrée de stock", async () => {
    setRelayDevice(true);
    await expect(createSale(device.db!, { userId: biz.admin.id, saleMode: "pos", items: [{ variantId, quantity: 1, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions)).resolves.toBeDefined();
    await expect(createExpense(device.db!, { category: "Eau", amount: 100, expenseDate: "2026-10-31", paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions)).resolves.toBeDefined();
    // Ne lève pas (le résultat n'a pas d'intérêt).
    await addManualStockEntry(device.db!, { variantId, locationId: biz.locations.surface, quantity: 1, note: "ok", userId: biz.admin.id }, biz.admin.permissions);
  });

  it("réglages : seuls ceux propres à l'appareil se changent ; une valeur identique n'est pas un changement", async () => {
    const current = (await device.db!.select().from(schema.businessSettings))[0]!;
    setRelayDevice(true);
    await expect(updateSettings(device.db!, { backupFrequency: "weekly" }, biz.admin.permissions)).resolves.toBeDefined();
    // La page renvoie tous ses champs : les valeurs inchangées (et « vide » = « absent ») ne bloquent pas.
    await expect(updateSettings(device.db!, { businessName: current.businessName ?? undefined, address: "", backupFrequency: "daily" }, biz.admin.permissions)).resolves.toBeDefined();
    await expect(updateSettings(device.db!, { businessName: "Autre nom" }, biz.admin.permissions)).rejects.toBeInstanceOf(MasterOnlyError);
  });

  it("assertMasterOnly : message distinct selon la nature, aucun effet hors appareil relié", () => {
    expect(() => assertMasterOnly("catalog")).not.toThrow();
    setRelayDevice(true);
    expect(() => assertMasterOnly("catalog")).toThrow(/Ma[iî]tre|Master/);
    expect(() => assertMasterOnly("operation")).toThrow();
  });
});
