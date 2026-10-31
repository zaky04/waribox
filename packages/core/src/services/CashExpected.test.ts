import { schema } from "@gestion-boutique/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, type TestDevice } from "../test/testDb";
import { getExpectedCashAmount, openSession } from "./CashSessionService";
import { createExpense } from "./ExpensesService";
import { createProduct } from "./ProductsService";
import { createPurchase } from "./PurchasesService";
import { createSale } from "./SalesService";
import { addManualStockEntry } from "./StockService";
import { createSupplier } from "./SuppliersService";

let device: TestDevice;
let biz: SeededBusiness;
let variantId: number;
let supplierId: number;

const expected = async (sessionId: number) => {
  const session = (await device.db!.select().from(schema.cashSessions)).find((s) => s.id === sessionId)!;
  return getExpectedCashAmount(device.db!, session);
};

beforeAll(async () => {
  device = await createDevice("cash-expected");
  biz = await seedBusiness(device.db!);
  const p = await createProduct(device.db!, { name: "P", purchasePrice: 100, salePrice: 1000, createdBy: biz.admin.id }, biz.admin.permissions);
  variantId = p.defaultVariant.id;
  supplierId = (await createSupplier(device.db!, { name: "F", createdBy: biz.admin.id }, biz.admin.permissions)).id;
  await addManualStockEntry(device.db!, { variantId, locationId: biz.locations.surface, quantity: 50, note: "départ", userId: biz.admin.id }, biz.admin.permissions);
});

afterAll(releaseDevices);

describe("montant attendu en caisse", () => {
  it("compte les ventes, retire les dépenses et achats payés en espèces, ignore les autres modes", async () => {
    // Dépense saisie AVANT l'ouverture : n'appartient pas à cette session.
    await createExpense(device.db!, { category: "Avant", amount: 777, expenseDate: "2026-10-30", paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions);
    // Même seconde que l'ouverture ci-dessous : on laisse passer une seconde pour que l'ordre soit net.
    await new Promise((r) => setTimeout(r, 1100));
    const session = await openSession(device.db!, { userId: biz.admin.id, storeId: biz.storeId, openingAmount: 10000 }, biz.admin.permissions);
    expect(await expected(session.id)).toBe(10000);

    await createSale(device.db!, { userId: biz.admin.id, saleMode: "pos", items: [{ variantId, quantity: 2, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions);
    expect(await expected(session.id)).toBe(12000);
    // Vente par carte : ne passe pas par le tiroir.
    await createSale(device.db!, { userId: biz.admin.id, saleMode: "pos", items: [{ variantId, quantity: 1, unitPrice: 1000 }], paymentMethod: "card", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions);
    expect(await expected(session.id)).toBe(12000);

    // Dépense en espèces avec une date d'effet ANTÉRIEURE (rattrapage) : c'est l'heure de saisie qui compte.
    await createExpense(device.db!, { category: "Eau", amount: 300, expenseDate: "2026-10-01", paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions);
    expect(await expected(session.id)).toBe(11700);
    // Dépense par mobile money : pas du tiroir.
    await createExpense(device.db!, { category: "Taxi", amount: 150, expenseDate: "2026-10-31", paymentMethod: "mobile_money", userId: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions);
    expect(await expected(session.id)).toBe(11700);

    // Achat payé comptant : sort du tiroir.
    await createPurchase(device.db!, { userId: biz.admin.id, supplierId, items: [{ variantId, quantity: 5, unitCost: 100 }], paymentMethod: "cash", storeId: biz.storeId }, biz.admin.permissions);
    expect(await expected(session.id)).toBe(11200);
  });
});
