import { schema } from "@gestion-boutique/database";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, type TestDevice } from "../test/testDb";
import { getControlsReport } from "./ControlsService";
import { createProduct } from "./ProductsService";

// Le rapport de contrôles filtre maintenant en SQL au lieu de relire 18 tables
// entières. Ce test fige sa sortie sur un jeu de données FIXE et varié (dates
// explicites, plusieurs boutiques et employés, remboursements d'anciennes ventes,
// créances de ticket non soldées, tickets prêts jamais retirés...) : toute
// différence avec la version d'origine casse le test.
//
// Régénérer l'instantané (volontairement, après un changement de règle) :
//   CAPTURE_CONTROLS=1 pnpm --filter @gestion-boutique/core exec vitest run src/services/ControlsReport.test.ts
const SNAPSHOT = join(__dirname, "ControlsReport.snapshot.json");

let device: TestDevice;
let biz: SeededBusiness;
let otherStore: number;
let variantId: number;

const d = (day: string, time = "10:00:00") => `${day} ${time}`;

beforeAll(async () => {
  device = await createDevice("controls");
  biz = await seedBusiness(device.db!);
  const db = device.db!;
  otherStore = (await db.insert(schema.stores).values({ name: "Autre boutique" }).returning().get()).id;
  const p = await createProduct(db, { name: "Article", purchasePrice: 400, salePrice: 1000, createdBy: biz.admin.id }, biz.admin.permissions);
  variantId = p.defaultVariant.id;
  const supplier = await db.insert(schema.suppliers).values({ name: "Fournisseur A" }).returning().get();
  const supplier2 = await db.insert(schema.suppliers).values({ name: "Fournisseur B" }).returning().get();

  const sale = (n: number, day: string, total: number, userId: number, storeId: number, time?: string) => ({
    number: `VTE-2026-${String(n).padStart(6, "0")}`,
    userId,
    storeId,
    saleMode: "pos",
    subtotal: total,
    discount: 0,
    taxTotal: 0,
    total,
    paymentStatus: "paid",
    createdAt: d(day, time),
  });
  // La vente n°4 manque volontairement (trou dans la suite) ; n°9 est dans l'autre boutique.
  const sales = await db
    .insert(schema.sales)
    .values([
      sale(1, "2026-05-02", 10000, biz.cashier.id, biz.storeId),
      sale(2, "2026-05-03", 20000, biz.cashier.id, biz.storeId),
      sale(3, "2026-05-10", 5000, biz.manager.id, biz.storeId),
      sale(5, "2026-05-11", 7000, biz.cashier.id, biz.storeId, "23:59:59"),
      sale(6, "2026-04-20", 15000, biz.cashier.id, biz.storeId), // avant la période
      sale(9, "2026-05-12", 3000, biz.admin.id, otherStore),
    ])
    .returning();
  const s = (n: number) => sales.find((x) => x.number === `VTE-2026-${String(n).padStart(6, "0")}`)!;

  await db.insert(schema.refunds).values([
    { saleId: s(1).id, userId: biz.manager.id, reason: "défaut", method: "cash", subtotal: 4000, taxTotal: 0, total: 4000, approvedBy: biz.admin.id, createdAt: d("2026-05-04") },
    { saleId: s(2).id, userId: biz.cashier.id, reason: "erreur", method: "cash", subtotal: 3000, taxTotal: 0, total: 3000, createdAt: d("2026-05-05") },
    { saleId: s(2).id, userId: biz.cashier.id, reason: "retour", method: "cash", subtotal: 2500, taxTotal: 0, total: 2500, createdAt: d("2026-05-06") },
    { saleId: s(6).id, userId: biz.manager.id, reason: "ancienne vente", method: "cash", subtotal: 1500, taxTotal: 0, total: 1500, createdAt: d("2026-05-07") }, // vente d'avant la période
    { saleId: s(9).id, userId: biz.admin.id, reason: "autre boutique", method: "cash", subtotal: 500, taxTotal: 0, total: 500, createdAt: d("2026-05-08") },
    { saleId: s(3).id, userId: biz.manager.id, reason: "hors période", method: "cash", subtotal: 100, taxTotal: 0, total: 100, createdAt: d("2026-06-30") },
  ]);

  const orders = await db
    .insert(schema.serviceOrders)
    .values([
      { number: "TCK-2026-000001", userId: biz.cashier.id, storeId: biz.storeId, subtotal: 3000, discount: 0, taxTotal: 0, total: 3000, paymentStatus: "paid", createdAt: d("2026-01-10"), closedAt: null },
      { number: "TCK-2026-000002", userId: biz.cashier.id, storeId: biz.storeId, subtotal: 8000, discount: 0, taxTotal: 0, total: 8000, paymentStatus: "credit", createdAt: d("2026-05-02"), closedAt: d("2026-05-09") },
      { number: "TCK-2026-000004", userId: biz.manager.id, storeId: biz.storeId, subtotal: 0, discount: 0, taxTotal: 0, total: 0, paymentStatus: "paid", createdAt: d("2026-05-03") },
      { number: "TCK-2026-000006", userId: biz.cashier.id, storeId: biz.storeId, subtotal: 500, discount: 0, taxTotal: 0, total: 500, paymentStatus: "credit", createdAt: d("2026-02-01"), closedAt: d("2026-02-02") },
      { number: "TCK-2026-000005", userId: biz.manager.id, storeId: biz.storeId, subtotal: 2000, discount: 0, taxTotal: 0, total: 2000, paymentStatus: "paid", createdAt: d("2026-05-04"), cancelledAt: d("2026-05-05"), cancelReason: "x", cancelledBy: biz.admin.id },
    ])
    .returning();
  const o = (n: number) => orders.find((x) => x.number === `TCK-2026-${String(n).padStart(6, "0")}`)!;
  await db.insert(schema.serviceOrderItems).values([
    { serviceOrderId: o(1).id, description: "Chemise", quantity: 1, unitPrice: 3000, discount: 0, taxRate: 0, total: 3000, status: "ready" }, // prêt jamais retiré
    { serviceOrderId: o(2).id, description: "Costume", quantity: 1, unitPrice: 8000, discount: 0, taxRate: 0, total: 8000, status: "picked_up" }, // retiré avec solde dû
    { serviceOrderId: o(6).id, description: "Retouche", quantity: 1, unitPrice: 500, discount: 0, taxRate: 0, total: 500, status: "picked_up" },
    { serviceOrderId: o(4).id, description: "Gratuit", quantity: 1, unitPrice: 0, discount: 0, taxRate: 0, total: 0, status: "received" },
  ]);

  await db.insert(schema.customerCredits).values([
    { customerId: (await db.insert(schema.customers).values({ fullName: "Client Crédit" }).returning().get()).id, saleId: s(3).id, storeId: biz.storeId, originalAmount: 2000, remainingBalance: 1200, status: "partial", approvedBy: biz.admin.id, createdAt: d("2026-05-10") },
    { customerId: 1, serviceOrderId: o(2).id, storeId: biz.storeId, originalAmount: 8000, remainingBalance: 8000, status: "open", createdAt: d("2026-05-09") },
    { customerId: 1, serviceOrderId: o(6).id, storeId: biz.storeId, originalAmount: 500, remainingBalance: 500, status: "open", createdAt: d("2026-02-02") }, // avant la période, ticket retiré non soldé
    { customerId: 1, saleId: s(6).id, storeId: biz.storeId, originalAmount: 900, remainingBalance: 900, status: "open", createdAt: d("2026-04-21") }, // avant la période
  ]);

  const mv = (type: string, ref: string | null, qty: number, userId: number, day: string, loc = biz.locations.surface, note?: string, approvedBy?: number) => ({
    variantId, locationId: loc, quantityDelta: qty, movementType: type, referenceType: ref, createdBy: userId, note, approvedBy, createdAt: d(day),
  });
  await db.insert(schema.stockMovements).values([
    mv("loss", "breakage", -3, biz.cashier.id, "2026-05-06", biz.locations.surface, "casse", biz.admin.id),
    mv("loss", "theft", -5, biz.manager.id, "2026-05-09"),
    mv("adjustment", "manual", 20, biz.manager.id, "2026-05-07", biz.locations.reserve, "stock initial"),
    mv("sale", "sale", -2, biz.cashier.id, "2026-05-02"),
    mv("loss", "breakage", -9, biz.cashier.id, "2026-04-10"), // avant la période
    mv("adjustment", "manual", 4, biz.cashier.id, "2026-05-30"), // après la période
  ]);

  await db.insert(schema.cashSessions).values([
    { userId: biz.cashier.id, storeId: biz.storeId, openingAmount: 5000, closingAmount: 9000, expectedAmount: 10000, openedAt: d("2026-05-02", "08:00:00"), closedAt: d("2026-05-02", "18:00:00") },
    { userId: biz.cashier.id, storeId: biz.storeId, openingAmount: 5000, closingAmount: 10000, expectedAmount: 10000, openedAt: d("2026-05-03", "08:00:00"), closedAt: d("2026-05-03", "18:00:00") },
    { userId: biz.manager.id, storeId: otherStore, openingAmount: 0, closingAmount: 1, expectedAmount: 500, openedAt: d("2026-05-04", "08:00:00"), closedAt: d("2026-05-04", "18:00:00") },
    { userId: biz.cashier.id, storeId: biz.storeId, openingAmount: 100, closingAmount: 1, expectedAmount: 1, openedAt: d("2026-04-01", "08:00:00"), closedAt: d("2026-04-01", "18:00:00") }, // avant
  ]);

  const purchaseRows = await db
    .insert(schema.purchases)
    .values([
      { number: "ACH-2026-000001", supplierId: supplier.id, userId: biz.manager.id, storeId: biz.storeId, total: 12000, status: "received", createdAt: d("2026-05-03") },
      { number: "ACH-2026-000002", supplierId: supplier.id, userId: biz.manager.id, storeId: biz.storeId, total: 9000, status: "ordered", createdAt: d("2026-05-09") },
      { number: "ACH-2026-000003", supplierId: supplier2.id, userId: biz.admin.id, storeId: biz.storeId, total: 500, status: "received", createdAt: d("2026-02-01") }, // avant
    ])
    .returning();
  const pr = (n: number) => purchaseRows.find((x) => x.number === `ACH-2026-${String(n).padStart(6, "0")}`)!;
  await db.insert(schema.purchaseItems).values([
    { purchaseId: pr(1).id, variantId, quantity: 30, unitCost: 400, priceAlert: true, receivedQuantity: 25 },
    { purchaseId: pr(2).id, variantId, quantity: 10, unitCost: 900 },
    { purchaseId: pr(3).id, variantId, quantity: 1, unitCost: 500, priceAlert: true },
  ]);
  await db.insert(schema.supplierDebts).values([{ supplierId: supplier.id, purchaseId: pr(1).id, storeId: biz.storeId, originalAmount: 4000, remainingBalance: 4000, status: "open" }]);

  const audit = (action: string, userId: number | null, day: string, metadata: Record<string, unknown> | null = null, entityId: number | null = null) => ({
    userId, action, entity: "x", entityId, metadata: metadata ? JSON.stringify(metadata) : null, createdAt: d(day),
  });
  await db.insert(schema.auditLog).values([
    audit("approval_failed", biz.cashier.id, "2026-05-05"),
    audit("approval_failed", biz.cashier.id, "2026-05-06"),
    audit("approval_failed", biz.cashier.id, "2026-05-07"),
    audit("approval_failed", biz.cashier.id, "2026-04-05"), // avant
    audit("update_product", biz.manager.id, "2026-05-08", { changes: { salePrice: [1, 2] } }),
    audit("update_expense", biz.manager.id, "2026-05-08"),
    audit("create_sale", biz.cashier.id, "2026-05-09", { number: "VTE-2026-000002", unauthorizedDiscount: 1500, discountApprovedBy: biz.admin.id }),
    audit("create_sale", biz.cashier.id, "2026-05-10", { number: "VTE-2026-000003", expiredOverride: { approvedBy: biz.admin.id, lines: [{ value: 700 }] } }),
    audit("approval_rejected", biz.cashier.id, "2026-05-11"),
    audit("approval_request_rejected", biz.admin.id, "2026-05-11", { requestedBy: biz.cashier.id }),
    audit("approval_request_approved", biz.admin.id, "2026-05-12"),
    audit("cancel_service_order", biz.manager.id, "2026-05-05", { approvedBy: biz.admin.id }),
    audit("adjust_loyalty_points", biz.cashier.id, "2026-05-13", { pointsDelta: -40, approvedBy: biz.admin.id }),
    audit("create_expense", biz.cashier.id, "2026-05-13", { approvedBy: biz.admin.id }),
    audit("stock_expired_writeoff", biz.manager.id, "2026-05-14", { approvedBy: biz.admin.id, value: 3000, batches: 2 }),
    audit("receive_purchase", biz.manager.id, "2026-05-15", { sameUser: true }, pr(1).id),
  ]);
});

afterAll(releaseDevices);

// Retire ce qui dépend de l'heure d'exécution (âge des tickets en jours).
function normalize<T>(report: T): unknown {
  return JSON.parse(JSON.stringify(report), (key, value) => (key === "ageDays" ? "<age>" : value));
}

describe("getControlsReport", () => {
  it("rend exactement l'instantané de référence (mai 2026, toutes boutiques)", async () => {
    const report = normalize(await getControlsReport(device.db!, { from: "2026-05-01", to: "2026-05-31" }));
    if (process.env.CAPTURE_CONTROLS) {
      const byStore = normalize(await getControlsReport(device.db!, { from: "2026-05-01", to: "2026-05-31" }, biz.storeId));
      const wide = normalize(await getControlsReport(device.db!, { from: "2026-01-01", to: "2026-12-31" }));
      writeFileSync(SNAPSHOT, JSON.stringify({ all: report, store: byStore, wide }, null, 1));
    }
    expect(existsSync(SNAPSHOT)).toBe(true);
    expect(report).toEqual(JSON.parse(readFileSync(SNAPSHOT, "utf-8")).all);
  });

  it("idem pour une seule boutique", async () => {
    const report = normalize(await getControlsReport(device.db!, { from: "2026-05-01", to: "2026-05-31" }, biz.storeId));
    expect(report).toEqual(JSON.parse(readFileSync(SNAPSHOT, "utf-8")).store);
  });

  it("idem sur toute l'année (période plus large que les données)", async () => {
    const report = normalize(await getControlsReport(device.db!, { from: "2026-01-01", to: "2026-12-31" }));
    expect(report).toEqual(JSON.parse(readFileSync(SNAPSHOT, "utf-8")).wide);
  });

  it("l'instantané n'est pas vide (le jeu de données exerce vraiment les règles)", () => {
    const snap = JSON.parse(readFileSync(SNAPSHOT, "utf-8")).all as { employees: unknown[]; alerts: unknown[]; suppliers: unknown[]; numberGaps: unknown[]; staleTickets: unknown[]; unpaidPickups: unknown[]; cashVariances: unknown[]; events: unknown[] };
    expect(snap.employees.length).toBeGreaterThanOrEqual(3);
    expect(snap.suppliers.length).toBeGreaterThanOrEqual(1);
    expect(snap.numberGaps.length).toBeGreaterThanOrEqual(1);
    expect(snap.staleTickets.length).toBe(1);
    expect(snap.unpaidPickups.length).toBe(2);
    expect(snap.cashVariances.length).toBe(3);
    expect(snap.events.length).toBeGreaterThanOrEqual(8);
    expect(snap.alerts.length).toBeGreaterThanOrEqual(4);
  });
});
