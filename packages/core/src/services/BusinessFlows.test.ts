import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, type TestDevice } from "../test/testDb";
import { closeSession, openSession } from "./CashSessionService";
import { recordCreditRepayment } from "./CreditsService";
import { createCustomer } from "./CustomersService";
import { createProduct } from "./ProductsService";
import { createPurchase } from "./PurchasesService";
import { createRefund } from "./RefundsService";
import { getCashFlow, getMarginsSummary, getSalesSummary } from "./ReportsService";
import { createSale } from "./SalesService";
import { getStockLevels, transferStock } from "./StockService";
import { createSupplier } from "./SuppliersService";
import { createExpense } from "./ExpensesService";

// Parcours métier réels sur une vraie base : on vérifie des INVARIANTS
// (stock, argent, marge, créances) plutôt que des détails d'implémentation.

let device: TestDevice;
let biz: SeededBusiness;
let variantA: number;
let variantC: number;
let supplierId: number;
let customerId: number;
const today = new Date().toISOString().slice(0, 10);
const range = { from: "2000-01-01", to: "2100-01-01" };

const stockAt = async (variantId: number, locationId: number) => {
  const levels = await getStockLevels(device.db!, biz.storeId);
  return levels.filter((l) => l.variantId === variantId && l.locationId === locationId).reduce((n, l) => n + l.quantity, 0);
};

const sale = (variantId: number, quantity: number, extra: Record<string, unknown> = {}) =>
  createSale(
    device.db!,
    { userId: biz.admin.id, saleMode: "pos", items: [{ variantId, quantity, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId, ...extra },
    biz.admin.permissions,
  );

beforeAll(async () => {
  device = await createDevice("flows");
  biz = await seedBusiness(device.db!);
  const db = device.db!;
  const a = await createProduct(db, { name: "Produit A", purchasePrice: 400, salePrice: 1000, createdBy: biz.admin.id }, biz.admin.permissions);
  const c = await createProduct(db, { name: "Produit C", purchasePrice: 100, salePrice: 1000, createdBy: biz.admin.id }, biz.admin.permissions);
  variantA = a.defaultVariant.id;
  variantC = c.defaultVariant.id;
  supplierId = (await createSupplier(db, { name: "Fournisseur", createdBy: biz.admin.id }, biz.admin.permissions)).id;
  customerId = (await createCustomer(db, { fullName: "Client Crédit", phone: "0700000000", createdBy: biz.admin.id }, biz.admin.permissions)).id;
});

afterAll(releaseDevices);

describe("achat → transfert → vente → remboursement", () => {
  it("l'achat entre en Réserve au bon coût", async () => {
    await createPurchase(
      device.db!,
      { userId: biz.admin.id, supplierId, items: [{ variantId: variantA, quantity: 30, unitCost: 450 }], paymentMethod: "cash", storeId: biz.storeId },
      biz.admin.permissions,
    );
    expect(await stockAt(variantA, biz.locations.reserve)).toBe(30);
  });

  it("le transfert déplace le stock sans en créer ni en perdre", async () => {
    await transferStock(device.db!, { variantId: variantA, fromLocationId: biz.locations.reserve, toLocationId: biz.locations.surface, quantity: 20, userId: biz.admin.id }, biz.admin.permissions);
    expect(await stockAt(variantA, biz.locations.reserve)).toBe(10);
    expect(await stockAt(variantA, biz.locations.surface)).toBe(20);
  });

  it("un transfert au-delà du stock est refusé et ne change rien", async () => {
    await expect(
      transferStock(device.db!, { variantId: variantA, fromLocationId: biz.locations.reserve, toLocationId: biz.locations.surface, quantity: 11, userId: biz.admin.id }, biz.admin.permissions),
    ).rejects.toThrow();
    expect(await stockAt(variantA, biz.locations.reserve)).toBe(10);
    expect(await stockAt(variantA, biz.locations.surface)).toBe(20);
  });

  it("la vente décrémente la surface, et la marge utilise le coût d'ACHAT (450) pas le prix catalogue (400)", async () => {
    const s = await sale(variantA, 3);
    expect(s.total).toBe(3000);
    expect(await stockAt(variantA, biz.locations.surface)).toBe(17);
    const margins = await getMarginsSummary(device.db!, range, biz.storeId);
    expect(margins.revenue).toBe(3000);
    expect(margins.cost).toBe(3 * 450);
  });

  it("un remboursement avec remise en stock rétablit le stock et déduit le chiffre d'affaires", async () => {
    const created = (await device.db!.select().from(schema.sales).orderBy(schema.sales.id))[0]!;
    const items = await device.db!.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, created.id));
    await createRefund(device.db!, { saleId: created.id, items: [{ saleItemId: items[0]!.id, quantity: 1, restock: true }], reason: "Client mécontent", method: "cash", userId: biz.admin.id }, biz.admin.permissions);
    expect(await stockAt(variantA, biz.locations.surface)).toBe(18);
    const summary = await getSalesSummary(device.db!, range, biz.storeId);
    expect(summary.totalRevenue).toBe(2000);
    const margins = await getMarginsSummary(device.db!, range, biz.storeId);
    expect(margins.revenue).toBe(2000);
    expect(margins.cost).toBe(2 * 450); // le coût de l'article remis en stock est annulé
  });

  it("on ne peut pas rembourser deux fois plus que vendu", async () => {
    const created = (await device.db!.select().from(schema.sales).orderBy(schema.sales.id))[0]!;
    const items = await device.db!.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, created.id));
    await expect(
      createRefund(device.db!, { saleId: created.id, items: [{ saleItemId: items[0]!.id, quantity: 3, restock: true }], reason: "Trop", method: "cash", userId: biz.admin.id }, biz.admin.permissions),
    ).rejects.toThrow();
    expect(await stockAt(variantA, biz.locations.surface)).toBe(18);
  });
});

describe("ventes à crédit", () => {
  let creditId: number;

  it("une vente partiellement payée crée une créance du reste", async () => {
    const s = await sale(variantA, 5, { customerId, amountPaid: 2000 });
    expect(s.paymentStatus).toBe("partial");
    const credit = await device.db!.select().from(schema.customerCredits).where(eq(schema.customerCredits.saleId, s.id)).get();
    expect(credit?.remainingBalance).toBe(3000);
    creditId = credit!.id;
  });

  it("les règlements réduisent la créance et ne peuvent pas la dépasser", async () => {
    await recordCreditRepayment(device.db!, { creditId, amount: 1000, method: "cash", userId: biz.admin.id }, biz.admin.permissions);
    let credit = await device.db!.select().from(schema.customerCredits).where(eq(schema.customerCredits.id, creditId)).get();
    expect(credit?.remainingBalance).toBe(2000);
    await expect(recordCreditRepayment(device.db!, { creditId, amount: 2500, method: "cash", userId: biz.admin.id }, biz.admin.permissions)).rejects.toThrow();
    await recordCreditRepayment(device.db!, { creditId, amount: 2000, method: "cash", userId: biz.admin.id }, biz.admin.permissions);
    credit = await device.db!.select().from(schema.customerCredits).where(eq(schema.customerCredits.id, creditId)).get();
    expect(credit?.remainingBalance).toBe(0);
    expect(credit?.status).toBe("settled");
  });

  it("la vente passe à « payée » une fois la créance soldée", async () => {
    const credit = await device.db!.select().from(schema.customerCredits).where(eq(schema.customerCredits.id, creditId)).get();
    const s = await device.db!.select().from(schema.sales).where(eq(schema.sales.id, credit!.saleId!)).get();
    expect(s?.paymentStatus).toBe("paid");
  });

  it("une vente à crédit sans client est refusée", async () => {
    await expect(sale(variantA, 1, { amountPaid: 0 })).rejects.toThrow();
  });
});

describe("concurrence et stock", () => {
  it("deux ventes simultanées de la dernière unité : une seule réussit", async () => {
    const db = device.db!;
    await createPurchase(db, { userId: biz.admin.id, supplierId, items: [{ variantId: variantC, quantity: 1, unitCost: 100 }], paymentMethod: "cash", storeId: biz.storeId }, biz.admin.permissions);
    await transferStock(db, { variantId: variantC, fromLocationId: biz.locations.reserve, toLocationId: biz.locations.surface, quantity: 1, userId: biz.admin.id }, biz.admin.permissions);
    const results = await Promise.allSettled([sale(variantC, 1), sale(variantC, 1)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await stockAt(variantC, biz.locations.surface)).toBe(0);
  });

  it("une quantité nulle, négative ou fractionnaire absurde est refusée", async () => {
    await expect(sale(variantA, 0)).rejects.toThrow();
    await expect(sale(variantA, -2)).rejects.toThrow();
  });

  it("un prix négatif est refusé", async () => {
    await expect(
      createSale(device.db!, { userId: biz.admin.id, saleMode: "pos", items: [{ variantId: variantA, quantity: 1, unitPrice: -500 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions),
    ).rejects.toThrow();
  });
});

describe("règlements simultanés et saisies invalides", () => {
  it("deux règlements simultanés d'une créance ne dépassent jamais le solde", async () => {
    const s = await sale(variantA, 3, { customerId, amountPaid: 0 });
    const credit = (await device.db!.select().from(schema.customerCredits).where(eq(schema.customerCredits.saleId, s.id)).get())!;
    expect(credit.remainingBalance).toBe(3000);
    const results = await Promise.allSettled([
      recordCreditRepayment(device.db!, { creditId: credit.id, amount: 2000, method: "cash", userId: biz.admin.id }, biz.admin.permissions),
      recordCreditRepayment(device.db!, { creditId: credit.id, amount: 2000, method: "cash", userId: biz.admin.id }, biz.admin.permissions),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const after = (await device.db!.select().from(schema.customerCredits).where(eq(schema.customerCredits.id, credit.id)).get())!;
    expect(after.remainingBalance).toBe(1000);
    const repayments = await device.db!.select().from(schema.creditRepayments).where(eq(schema.creditRepayments.creditId, credit.id));
    expect(repayments.reduce((n, r) => n + r.amount, 0)).toBe(2000);
  });

  it("un montant de règlement NaN, nul ou négatif est refusé", async () => {
    const credit = (await device.db!.select().from(schema.customerCredits).where(eq(schema.customerCredits.status, "partial")).get())!;
    for (const amount of [Number.NaN, 0, -100, Number.POSITIVE_INFINITY]) {
      await expect(recordCreditRepayment(device.db!, { creditId: credit.id, amount, method: "cash", userId: biz.admin.id }, biz.admin.permissions)).rejects.toThrow();
    }
  });

  it("quantités et prix invalides refusés à la vente (NaN, infini, négatif)", async () => {
    const before = await stockAt(variantA, biz.locations.surface);
    for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY, -1]) await expect(sale(variantA, quantity)).rejects.toThrow();
    await expect(sale(variantA, 1, { discount: -50 })).rejects.toThrow();
    await expect(sale(variantA, 1, { amountPaid: -10 })).rejects.toThrow();
    expect(await stockAt(variantA, biz.locations.surface)).toBe(before);
  });

  it("une remise de ligne supérieure au montant de la ligne est refusée", async () => {
    await expect(
      createSale(device.db!, { userId: biz.admin.id, saleMode: "pos", items: [{ variantId: variantA, quantity: 1, unitPrice: 1000, discount: 5000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions),
    ).rejects.toThrow();
  });

  it("une dépense de montant nul, négatif ou NaN est refusée", async () => {
    for (const amount of [0, -5, Number.NaN]) {
      await expect(
        createExpense(device.db!, { category: "Test", amount, expenseDate: today, paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions),
      ).rejects.toThrow();
    }
  });

  it("un produit à prix négatif ou à TVA hors 0-100 est refusé", async () => {
    await expect(createProduct(device.db!, { name: "Mauvais", purchasePrice: -1, salePrice: 100 }, biz.admin.permissions)).rejects.toThrow();
    await expect(createProduct(device.db!, { name: "Mauvais", purchasePrice: 1, salePrice: -100 }, biz.admin.permissions)).rejects.toThrow();
    await expect(createProduct(device.db!, { name: "Mauvais", purchasePrice: 1, salePrice: 100, taxRate: 150 }, biz.admin.permissions)).rejects.toThrow();
  });
});

describe("caisse", () => {
  it("le montant attendu à la clôture = fond de caisse + espèces encaissées pendant la session", async () => {
    const db = device.db!;
    // Les mouvements d'argent précédents datent d'avant l'ouverture de la caisse
    // (dans ce test tout se passe dans la même seconde, ce qui n'arrive pas en vrai).
    await db.update(schema.payments).set({ createdAt: "2020-01-01 00:00:00" }).run();
    await db.update(schema.creditRepayments).set({ paidAt: "2020-01-01 00:00:00" }).run();
    const session = await openSession(db, { userId: biz.admin.id, storeId: biz.storeId, openingAmount: 10000 }, biz.admin.permissions);
    await sale(variantA, 2); // 2 000 en espèces
    const result = await closeSession(db, { sessionId: session.id, closingAmount: 12000 }, biz.admin.permissions);
    expect(result.expectedAmount).toBe(12000);
    expect(result.difference).toBe(0);
  });
});

describe("caisse : doubles validations", () => {
  it("ouvrir deux fois la caisse en même temps ne crée qu'une session ; la fermer deux fois est refusé", async () => {
    const db = device.db!;
    const other = biz.manager; // un autre utilisateur, aucune session ouverte
    const open = () => openSession(db, { userId: other.id, storeId: biz.storeId, openingAmount: 500 }, { ...biz.admin.permissions });
    const [a, b] = await Promise.all([open(), open()]);
    expect(a.id).toBe(b.id);
    const sessions = (await db.select().from(schema.cashSessions)).filter((x) => x.userId === other.id && !x.closedAt);
    expect(sessions).toHaveLength(1);
    const close = () => closeSession(db, { sessionId: a.id, closingAmount: 500 }, biz.admin.permissions);
    const results = await Promise.allSettled([close(), close()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(closeSession(db, { sessionId: a.id, closingAmount: -5 }, biz.admin.permissions)).rejects.toThrow();
  });
});

describe("trésorerie", () => {
  it("les entrées d'argent de la période comptent les ventes et les règlements, et les remboursements en sortie", async () => {
    const cash = await getCashFlow(device.db!, range, biz.storeId);
    expect(cash).toBeDefined();
    expect(JSON.stringify(cash)).not.toContain("NaN");
    expect(JSON.stringify(cash)).not.toContain("null");
  });

  it("aucune date du jour n'est décalée", () => {
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
