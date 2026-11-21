import { schema } from "@gestion-boutique/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, useDevice, type TestDevice } from "../test/testDb";
import { cancelStockCount, getOpenStockCount, saveCountedQuantity, startStockCount } from "./InventoryService";
import { createProduct } from "./ProductsService";
import { addManualStockEntry, getStockLevels } from "./StockService";

// Un inventaire en cours doit pouvoir être abandonné (sinon l'écran est un cul-de-sac) sans toucher au stock.
describe("abandon d'un inventaire en cours", () => {
  let device: TestDevice;
  let biz: SeededBusiness;
  let variantId = 0;

  beforeAll(async () => {
    device = await createDevice("inventory-cancel");
    biz = await seedBusiness(device.db!);
    const p = await createProduct(device.db!, { name: "Riz", purchasePrice: 600, salePrice: 1000, createdBy: biz.admin.id }, biz.admin.permissions);
    variantId = p.defaultVariant.id;
    await addManualStockEntry(device.db!, { variantId, locationId: biz.locations.surface, quantity: 10, note: "départ", userId: biz.admin.id }, biz.admin.permissions);
  });
  afterAll(releaseDevices);

  const stock = async () => (await getStockLevels(device.db!, biz.storeId)).filter((l) => l.variantId === variantId).reduce((n, l) => n + l.quantity, 0);

  it("supprime le comptage et ses lignes, laisse le stock intact, permet d'en rouvrir un", async () => {
    useDevice(device);
    const count = await startStockCount(device.db!, { storeId: biz.storeId, locationId: biz.locations.surface, userId: biz.admin.id }, biz.admin.permissions);
    await saveCountedQuantity(device.db!, { countId: count.id, variantId, countedQuantity: 3 }, biz.admin.permissions);
    expect((await getOpenStockCount(device.db!, biz.locations.surface))?.id).toBe(count.id);

    await cancelStockCount(device.db!, { countId: count.id, userId: biz.admin.id }, biz.admin.permissions);
    expect(await getOpenStockCount(device.db!, biz.locations.surface)).toBeUndefined();
    expect(await device.db!.select().from(schema.stockCountLines)).toEqual([]);
    expect(await stock()).toBe(10); // la quantité saisie (3) n'a jamais été appliquée

    const again = await startStockCount(device.db!, { storeId: biz.storeId, locationId: biz.locations.surface, userId: biz.admin.id }, biz.admin.permissions);
    expect(again.id).not.toBe(count.id);
    await cancelStockCount(device.db!, { countId: again.id, userId: biz.admin.id }, biz.admin.permissions);
  });

  it("refuse un inventaire inexistant, déjà abandonné, ou sans le droit", async () => {
    useDevice(device);
    await expect(cancelStockCount(device.db!, { countId: 9999, userId: biz.admin.id }, biz.admin.permissions)).rejects.toThrow();
    const count = await startStockCount(device.db!, { storeId: biz.storeId, locationId: biz.locations.reserve, userId: biz.admin.id }, biz.admin.permissions);
    await expect(cancelStockCount(device.db!, { countId: count.id, userId: biz.cashier.id }, biz.cashier.permissions)).rejects.toThrow();
    await cancelStockCount(device.db!, { countId: count.id, userId: biz.admin.id }, biz.admin.permissions);
    await expect(cancelStockCount(device.db!, { countId: count.id, userId: biz.admin.id }, biz.admin.permissions)).rejects.toThrow();
  });
});
