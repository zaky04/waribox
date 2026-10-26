import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, type TestDevice } from "../test/testDb";
import { createCustomer } from "./CustomersService";
import { recordDebtPayment } from "./DebtsService";
import { createProduct } from "./ProductsService";
import { createPurchase, receivePurchase } from "./PurchasesService";
import { getSettings } from "./SettingsService";
import { closeStockCount, saveCountedQuantity, startStockCount } from "./InventoryService";
import { createRefund } from "./RefundsService";
import { createSale } from "./SalesService";
import { createServiceOrder, cancelServiceOrder, updateServiceOrderItemStatus } from "./ServiceOrdersService";
import { addManualStockEntry, getStockLevels, recordStockLoss } from "./StockService";
import { convertQuoteToSale, createQuote } from "./QuotesService";
import { createSupplier } from "./SuppliersService";
import { decideApprovalRequest } from "./ApprovalRequestsService";
import { createApprovalRequest } from "./ApprovalService";

// Deuxième série de parcours métier : remboursement d'une vente à crédit, achats
// à crédit et dettes, pertes de stock, tickets de service.

let device: TestDevice;
let biz: SeededBusiness;
let variant: number;
let supplierId: number;
let customerId: number;

const surfaceStock = async () => {
  const levels = await getStockLevels(device.db!, biz.storeId);
  return levels.filter((l) => l.variantId === variant && l.locationId === biz.locations.surface).reduce((n, l) => n + l.quantity, 0);
};
const creditSale = (quantity: number, amountPaid: number) =>
  createSale(
    device.db!,
    { userId: biz.admin.id, customerId, saleMode: "pos", items: [{ variantId: variant, quantity, unitPrice: 1000 }], paymentMethod: "cash", amountPaid, surfaceLocationId: biz.locations.surface, storeId: biz.storeId },
    biz.admin.permissions,
  );
const refundAll = async (saleId: number, quantity: number) => {
  const item = (await device.db!.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, saleId)))[0]!;
  return createRefund(device.db!, { saleId, items: [{ saleItemId: item.id, quantity, restock: true }], reason: "Retour", method: "cash", userId: biz.admin.id }, biz.admin.permissions);
};
const creditOf = (saleId: number) => device.db!.select().from(schema.customerCredits).where(eq(schema.customerCredits.saleId, saleId)).get();
const refundPayments = async (refundId: number) =>
  (await device.db!.select().from(schema.payments).where(eq(schema.payments.referenceId, refundId))).filter((p) => p.referenceType === "refund");

beforeAll(async () => {
  device = await createDevice("flows2");
  biz = await seedBusiness(device.db!);
  const db = device.db!;
  const p = await createProduct(db, { name: "Article", purchasePrice: 300, salePrice: 1000, createdBy: biz.admin.id }, biz.admin.permissions);
  variant = p.defaultVariant.id;
  supplierId = (await createSupplier(db, { name: "Fournisseur", createdBy: biz.admin.id }, biz.admin.permissions)).id;
  customerId = (await createCustomer(db, { fullName: "Client", phone: "0700000001", createdBy: biz.admin.id }, biz.admin.permissions)).id;
  await addManualStockEntry(db, { variantId: variant, locationId: biz.locations.surface, quantity: 100, userId: biz.admin.id, note: "init" }, biz.admin.permissions);
});

afterAll(releaseDevices);

describe("remboursement d'une vente à crédit", () => {
  it("rendre toute la marchandise annule la créance et ne rembourse en espèces que ce qui a été payé", async () => {
    const s = await creditSale(5, 2000); // 5 000 dont 2 000 payés, 3 000 à crédit
    const refund = await refundAll(s.id, 5);
    const payments = await refundPayments(refund.id);
    expect(payments.reduce((n, p) => n + p.amount, 0)).toBe(2000); // jamais plus que l'argent reçu
    const credit = (await creditOf(s.id))!;
    expect(credit.remainingBalance).toBe(0);
    expect(credit.status).toBe("settled");
  });

  it("un remboursement partiel entame d'abord la créance, sans sortie d'argent", async () => {
    const s = await creditSale(5, 1000); // 4 000 à crédit
    const refund = await refundAll(s.id, 2); // 2 000 de marchandise rendue
    expect(await refundPayments(refund.id)).toHaveLength(0);
    expect((await creditOf(s.id))!.remainingBalance).toBe(2000);
  });

  it("un remboursement qui dépasse la créance rend le surplus en espèces", async () => {
    const s = await creditSale(5, 4000); // 1 000 à crédit
    const refund = await refundAll(s.id, 3); // 3 000 rendus : 1 000 annulent la créance, 2 000 en espèces
    const payments = await refundPayments(refund.id);
    expect(payments.reduce((n, p) => n + p.amount, 0)).toBe(2000);
    expect((await creditOf(s.id))!.remainingBalance).toBe(0);
  });

  it("une vente entièrement payée est remboursée en entier en espèces, comme avant", async () => {
    const s = await createSale(device.db!, { userId: biz.admin.id, saleMode: "pos", items: [{ variantId: variant, quantity: 2, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions);
    const refund = await refundAll(s.id, 2);
    expect((await refundPayments(refund.id)).reduce((n, p) => n + p.amount, 0)).toBe(2000);
  });
});

describe("achats à crédit et dettes fournisseurs", () => {
  it("un achat partiellement payé crée une dette du reste ; les paiements ne la dépassent jamais, même simultanés", async () => {
    const db = device.db!;
    await createPurchase(db, { userId: biz.admin.id, supplierId, items: [{ variantId: variant, quantity: 10, unitCost: 300 }], paymentMethod: "credit", amountPaid: 1000, storeId: biz.storeId }, biz.admin.permissions);
    const debt = (await db.select().from(schema.supplierDebts))[0]!;
    expect(debt.remainingBalance).toBe(2000);

    const results = await Promise.allSettled([
      recordDebtPayment(db, { debtId: debt.id, amount: 1500, userId: biz.admin.id }, biz.admin.permissions),
      recordDebtPayment(db, { debtId: debt.id, amount: 1500, userId: biz.admin.id }, biz.admin.permissions),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const after = (await db.select().from(schema.supplierDebts).where(eq(schema.supplierDebts.id, debt.id)).get())!;
    expect(after.remainingBalance).toBe(500);
    await recordDebtPayment(db, { debtId: debt.id, amount: 500, userId: biz.admin.id }, biz.admin.permissions);
    expect((await db.select().from(schema.supplierDebts).where(eq(schema.supplierDebts.id, debt.id)).get())!.status).toBe("settled");
  });

  it("un prix d'achat négatif ou une quantité nulle est refusé", async () => {
    const db = device.db!;
    await expect(createPurchase(db, { userId: biz.admin.id, supplierId, items: [{ variantId: variant, quantity: 1, unitCost: -5 }], paymentMethod: "cash", storeId: biz.storeId }, biz.admin.permissions)).rejects.toThrow();
    await expect(createPurchase(db, { userId: biz.admin.id, supplierId, items: [{ variantId: variant, quantity: 0, unitCost: 5 }], paymentMethod: "cash", storeId: biz.storeId }, biz.admin.permissions)).rejects.toThrow();
  });
});

describe("pertes de stock", () => {
  it("une perte retire du stock et ne peut pas dépasser ce qui existe", async () => {
    const before = await surfaceStock();
    await recordStockLoss(device.db!, { variantId: variant, locationId: biz.locations.surface, quantity: 4, reason: "breakage", userId: biz.admin.id }, biz.admin.permissions);
    expect(await surfaceStock()).toBe(before - 4);
    await expect(
      recordStockLoss(device.db!, { variantId: variant, locationId: biz.locations.surface, quantity: before + 1000, reason: "breakage", userId: biz.admin.id }, biz.admin.permissions),
    ).rejects.toThrow();
    expect(await surfaceStock()).toBe(before - 4);
  });
});

describe("tickets de service", () => {
  const order = (items: Array<{ description: string; quantity: number; unitPrice: number }>, amountPaid?: number) =>
    createServiceOrder(device.db!, { userId: biz.admin.id, customerId, items, paymentMethod: "cash", amountPaid, storeId: biz.storeId }, biz.admin.permissions);

  it("un ticket à prix négatif ou quantité nulle est refusé", async () => {
    await expect(order([{ description: "x", quantity: 1, unitPrice: -100 }])).rejects.toThrow();
    await expect(order([{ description: "x", quantity: 0, unitPrice: 100 }])).rejects.toThrow();
  });

  it("annuler un ticket encaissé rembourse l'encaissé (ligne négative) et le ticket disparaît des totaux", async () => {
    const created = (await order([{ description: "Chemise", quantity: 2, unitPrice: 1500 }], 3000)) as { order?: { id: number }; id?: number };
    const id = created.order?.id ?? created.id!;
    await cancelServiceOrder(device.db!, { orderId: id, userId: biz.admin.id, reason: "Client parti" }, biz.admin.permissions);
    const payments = (await device.db!.select().from(schema.payments)).filter((p) => p.referenceType === "service_order" && p.referenceId === id);
    expect(payments.reduce((n, p) => n + p.amount, 0)).toBe(0); // 3 000 encaissés − 3 000 rendus
    const row = (await device.db!.select().from(schema.serviceOrders).where(eq(schema.serviceOrders.id, id)).get())!;
    expect(row.cancelledAt).toBeTruthy();
  });

  it("un ticket annulé ne peut plus avancer ni être annulé deux fois", async () => {
    const created = (await order([{ description: "Pantalon", quantity: 1, unitPrice: 2000 }], 2000)) as { order?: { id: number }; id?: number };
    const id = created.order?.id ?? created.id!;
    await cancelServiceOrder(device.db!, { orderId: id, userId: biz.admin.id, reason: "Erreur" }, biz.admin.permissions);
    await expect(cancelServiceOrder(device.db!, { orderId: id, userId: biz.admin.id, reason: "Encore" }, biz.admin.permissions)).rejects.toThrow();
    const item = (await device.db!.select().from(schema.serviceOrderItems).where(eq(schema.serviceOrderItems.serviceOrderId, id)))[0]!;
    await expect(updateServiceOrderItemStatus(device.db!, { itemId: item.id, status: "ready", userId: biz.admin.id }, biz.admin.permissions)).rejects.toThrow();
  });

  it("deux retraits simultanés (double clic, deux articles) ne créent qu'UNE créance pour le solde dû", async () => {
    const created = (await order([
      { description: "Veste", quantity: 1, unitPrice: 2000 },
      { description: "Jupe", quantity: 1, unitPrice: 1000 },
    ], 0)) as { order?: { id: number }; id?: number };
    const id = created.order?.id ?? created.id!;
    const items = await device.db!.select().from(schema.serviceOrderItems).where(eq(schema.serviceOrderItems.serviceOrderId, id));
    expect(items).toHaveLength(2);
    const results = await Promise.allSettled([
      updateServiceOrderItemStatus(device.db!, { itemId: items[0]!.id, status: "picked_up", userId: biz.admin.id }, biz.admin.permissions),
      updateServiceOrderItemStatus(device.db!, { itemId: items[1]!.id, status: "picked_up", userId: biz.admin.id }, biz.admin.permissions),
      updateServiceOrderItemStatus(device.db!, { itemId: items[0]!.id, status: "picked_up", userId: biz.admin.id }, biz.admin.permissions),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const credits = await device.db!.select().from(schema.customerCredits).where(eq(schema.customerCredits.serviceOrderId, id));
    expect(credits).toHaveLength(1);
    expect(credits[0]!.originalAmount).toBe(3000);
  });
});

describe("devis", () => {
  const convert = (quoteId: number) =>
    convertQuoteToSale(device.db!, quoteId, { surfaceLocationId: biz.locations.surface, paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions);
  const newQuote = async (quantity: number) =>
    createQuote(device.db!, { customerId, items: [{ variantId: variant, quantity, unitPrice: 1000 }], createdBy: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions);

  it("convertir deux fois le même devis en même temps ne crée qu'UNE vente et ne décrémente le stock qu'une fois", async () => {
    const quote = await newQuote(3);
    const salesBefore = (await device.db!.select().from(schema.sales)).length;
    const stockBefore = await surfaceStock();
    const results = await Promise.allSettled([convert(quote.id), convert(quote.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await device.db!.select().from(schema.sales)).length).toBe(salesBefore + 1);
    expect(await surfaceStock()).toBe(stockBefore - 3);
    const row = (await device.db!.select().from(schema.quotes).where(eq(schema.quotes.id, quote.id)).get())!;
    expect(row.status).toBe("converted");
    expect(row.convertedSaleId).not.toBeNull();
  });

  it("une conversion qui échoue (stock insuffisant) remet le devis dans son état d'origine", async () => {
    const quote = await newQuote(100000);
    await expect(convert(quote.id)).rejects.toThrow();
    const row = (await device.db!.select().from(schema.quotes).where(eq(schema.quotes.id, quote.id)).get())!;
    expect(row.status).not.toBe("converted");
    expect(row.convertedSaleId).toBeNull();
  });
});

describe("doubles validations (double clic, deux postes)", () => {
  it("réceptionner deux fois le même achat en même temps ne fait entrer la marchandise qu'une fois", async () => {
    const db = device.db!;
    await getSettings(db);
    await db.update(schema.businessSettings).set({ requirePurchaseReceipt: true }).run();
    try {
      await createPurchase(db, { userId: biz.admin.id, supplierId, items: [{ variantId: variant, quantity: 7, unitCost: 300 }], paymentMethod: "cash", storeId: biz.storeId }, biz.admin.permissions);
      const purchase = (await db.select().from(schema.purchases).orderBy(schema.purchases.id)).at(-1)!;
      expect(purchase.status).toBe("ordered");
      const items = await db.select().from(schema.purchaseItems).where(eq(schema.purchaseItems.purchaseId, purchase.id));
      const receive = () =>
        receivePurchase(db, { purchaseId: purchase.id, userId: biz.admin.id, lines: items.map((i) => ({ purchaseItemId: i.id, receivedQuantity: i.quantity })) }, biz.admin.permissions);
      const levels = async () => (await getStockLevels(db, biz.storeId)).filter((l) => l.variantId === variant && l.locationId === biz.locations.reserve).reduce((n, l) => n + l.quantity, 0);
      const before = await levels();
      const results = await Promise.allSettled([receive(), receive()]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await levels()).toBe(before + 7);
    } finally {
      await db.update(schema.businessSettings).set({ requirePurchaseReceipt: false }).run();
    }
  });

  it("clôturer deux fois le même inventaire en même temps ne le régularise qu'une fois", async () => {
    const db = device.db!;
    const count = await startStockCount(db, { locationId: biz.locations.surface, storeId: biz.storeId, userId: biz.admin.id }, biz.admin.permissions);
    const systemQty = await surfaceStock();
    await saveCountedQuantity(db, { countId: count.id, variantId: variant, countedQuantity: systemQty - 5 }, biz.admin.permissions);
    const close = () => closeStockCount(db, { countId: count.id, userId: biz.admin.id }, biz.admin.permissions);
    const results = await Promise.allSettled([close(), close()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await surfaceStock()).toBe(systemQty - 5);
    const adjustments = (await db.select().from(schema.stockMovements)).filter((m) => m.referenceType === "inventory" && m.referenceId === count.id);
    expect(adjustments.reduce((n, m) => n + m.quantityDelta, 0)).toBe(-5);
  });

  it("annuler deux fois le même ticket en même temps ne rembourse l'encaissé qu'une fois", async () => {
    const db = device.db!;
    const created = (await createServiceOrder(db, { userId: biz.admin.id, customerId, items: [{ description: "Robe", quantity: 1, unitPrice: 4000 }], paymentMethod: "cash", amountPaid: 4000, storeId: biz.storeId }, biz.admin.permissions)) as { order?: { id: number }; id?: number };
    const id = created.order?.id ?? created.id!;
    const cancel = () => cancelServiceOrder(db, { orderId: id, userId: biz.admin.id, reason: "Double clic" }, biz.admin.permissions);
    const results = await Promise.allSettled([cancel(), cancel()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const net = (await db.select().from(schema.payments)).filter((p) => p.referenceType === "service_order" && p.referenceId === id).reduce((n, p) => n + p.amount, 0);
    expect(net).toBe(0); // 4 000 encaissés − 4 000 rendus, pas −4 000
  });

  it("approuver deux fois la même demande de points en même temps ne les crédite qu'une fois", async () => {
    const db = device.db!;
    const before = (await db.select().from(schema.customers).where(eq(schema.customers.id, customerId)).get())!.loyaltyPoints;
    const request = await createApprovalRequest(db, {
      kind: "points",
      amount: 10,
      requestedBy: biz.cashier.id,
      storeId: biz.storeId,
      summary: "Ajustement de points",
      payload: { input: { customerId, pointsDelta: 10, userId: biz.cashier.id, reason: "geste commercial" } },
    });
    const decide = () => decideApprovalRequest(db, { requestId: request.id, approve: true, userId: biz.admin.id }, biz.admin.permissions);
    const results = await Promise.allSettled([decide(), decide()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const after = (await db.select().from(schema.customers).where(eq(schema.customers.id, customerId)).get())!.loyaltyPoints;
    expect(after - before).toBe(10);
  });
});
