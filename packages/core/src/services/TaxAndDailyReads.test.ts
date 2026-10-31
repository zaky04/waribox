import { schema } from "@gestion-boutique/database";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, type TestDevice } from "../test/testDb";
import { createProduct } from "./ProductsService";
import { ensureLocationsForStore } from "./StockService";
import { getDailySummary, getVerificationSample } from "./DailySummaryService";
import { getTaxCollected } from "./ReportsService";

// getTaxCollected et le résumé du jour ont été réécrits pour filtrer en SQL au lieu de relire des tables entières.
// Ce test compare leur sortie, sur un jeu de données varié, à un instantané pris avec l'ANCIENNE implémentation :
//   CAPTURE_READS=1 pnpm --filter @gestion-boutique/core exec vitest run src/services/TaxAndDailyReads.test.ts
const SNAPSHOT = join(__dirname, "TaxAndDailyReads.snapshot.json");
const d = (day: string, time = "10:00:00") => `${day} ${time}`;

let device: TestDevice;
let biz: SeededBusiness;
let otherStore: number;
let otherLocation: number;

beforeAll(async () => {
  device = await createDevice("reads");
  biz = await seedBusiness(device.db!);
  const db = device.db!;
  otherStore = (await db.insert(schema.stores).values({ name: "Autre" }).returning().get()).id;
  otherLocation = (await ensureLocationsForStore(db, otherStore)).surface_vente;
  const p = await createProduct(db, { name: "P", purchasePrice: 400, salePrice: 1000, createdBy: biz.admin.id }, biz.admin.permissions);
  const variantId = p.defaultVariant.id;
  const customers = await db
    .insert(schema.customers)
    .values([
      { fullName: "Avec Tel", phone: "0700000001", syncId: "c1" },
      { fullName: "Sans Tel", syncId: "c2" },
    ])
    .returning();

  const mk = (n: number, day: string, total: number, tax: number, storeId: number, customerId: number | null = null) => ({
    number: `VTE-R-${n}`,
    userId: biz.admin.id,
    storeId,
    customerId,
    saleMode: "pos",
    subtotal: total,
    discount: 0,
    taxTotal: tax,
    total,
    paymentStatus: "paid",
    createdAt: d(day),
  });
  const sales = await db
    .insert(schema.sales)
    .values([
      mk(1, "2026-03-01", 1180, 180, biz.storeId, customers[0]!.id),
      mk(2, "2026-03-02", 590, 90, otherStore),
      mk(3, "2026-03-02", 1000, 0, biz.storeId, customers[1]!.id),
      mk(4, "2026-02-15", 2360, 360, biz.storeId, customers[0]!.id),
      mk(5, "2026-03-02", 1180, 180, biz.storeId),
    ])
    .returning();
  const s = (n: number) => sales.find((x) => x.number === `VTE-R-${n}`)!;
  await db.insert(schema.refunds).values([
    { saleId: s(1).id, userId: biz.admin.id, reason: "r", method: "cash", subtotal: 590, taxTotal: 90, total: 590, createdAt: d("2026-03-02") },
    { saleId: s(2).id, userId: biz.admin.id, reason: "r", method: "cash", subtotal: 100, taxTotal: 15, total: 100, createdAt: d("2026-03-02") },
    { saleId: s(4).id, userId: biz.admin.id, reason: "r", method: "cash", subtotal: 1180, taxTotal: 180, total: 1180, createdAt: d("2026-03-05") },
  ]);

  await db.insert(schema.serviceOrders).values([
    { number: "TCK-R-1", userId: biz.cashier.id, storeId: biz.storeId, customerId: customers[0]!.id, subtotal: 700, discount: 0, taxTotal: 0, total: 700, paymentStatus: "paid", createdAt: d("2026-03-02") },
    { number: "TCK-R-2", userId: biz.cashier.id, storeId: biz.storeId, subtotal: 300, discount: 0, taxTotal: 0, total: 300, paymentStatus: "paid", createdAt: d("2026-03-02"), cancelledAt: d("2026-03-02", "12:00:00"), cancelReason: "x", cancelledBy: biz.admin.id },
    { number: "TCK-R-3", userId: biz.cashier.id, storeId: otherStore, customerId: customers[1]!.id, subtotal: 900, discount: 0, taxTotal: 0, total: 900, paymentStatus: "paid", createdAt: d("2026-03-02") },
    { number: "TCK-R-4", userId: biz.cashier.id, storeId: biz.storeId, subtotal: 100, discount: 0, taxTotal: 0, total: 100, paymentStatus: "paid", createdAt: d("2026-03-03") },
  ]);

  const mv = (type: string, ref: string, qty: number, day: string, locationId: number) => ({
    variantId,
    locationId,
    quantityDelta: qty,
    movementType: type,
    referenceType: ref,
    createdBy: biz.admin.id,
    createdAt: d(day),
  });
  await db.insert(schema.stockMovements).values([
    mv("loss", "breakage", -2, "2026-03-02", biz.locations.surface),
    mv("loss", "theft", -1, "2026-03-02", otherLocation),
    mv("adjustment", "manual", 5, "2026-03-02", biz.locations.reserve),
    mv("adjustment", "manual", -3, "2026-03-02", biz.locations.reserve), // régularisation négative : pas une entrée
    mv("sale", "sale", -4, "2026-03-02", biz.locations.surface),
    mv("loss", "breakage", -7, "2026-03-03", biz.locations.surface),
  ]);

  await db.insert(schema.expenses).values([
    { category: "Eau", amount: 200, expenseDate: "2026-03-02", paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId },
    { category: "Loyer", amount: 100, expenseDate: "2026-03-02", paymentMethod: "cash", userId: biz.admin.id, storeId: otherStore },
    { category: "Taxi", amount: 50, expenseDate: "2026-03-03", paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId },
  ]);

  await db.insert(schema.cashSessions).values([
    { userId: biz.cashier.id, storeId: biz.storeId, openingAmount: 100, closingAmount: 9900, expectedAmount: 10000, openedAt: d("2026-03-02", "08:00:00"), closedAt: d("2026-03-02", "17:00:00") },
    { userId: biz.cashier.id, storeId: otherStore, openingAmount: 100, closingAmount: 50, expectedAmount: 100, openedAt: d("2026-03-02", "08:00:00"), closedAt: d("2026-03-02", "18:00:00") },
    { userId: biz.cashier.id, storeId: biz.storeId, openingAmount: 100, openedAt: d("2026-03-02", "19:00:00") }, // encore ouverte
    { userId: biz.cashier.id, storeId: biz.storeId, openingAmount: 100, closingAmount: 1, expectedAmount: 100, openedAt: d("2026-03-03", "08:00:00"), closedAt: d("2026-03-03", "18:00:00") },
  ]);

  const audit = (action: string, day: string, metadata: Record<string, unknown> = {}) => ({ userId: biz.cashier.id, action, entity: "x", metadata: JSON.stringify(metadata), createdAt: d(day, "11:00:00") });
  await db.insert(schema.auditLog).values([
    audit("create_sale", "2026-03-02", { unauthorizedDiscount: 300, discountApprovedBy: biz.admin.id }),
    audit("create_service_order", "2026-03-02", { unauthorizedDiscount: 50 }),
    audit("create_sale", "2026-03-03", { unauthorizedDiscount: 999 }),
    audit("cancel_service_order", "2026-03-02", { approvedBy: biz.admin.id }),
    audit("create_expense", "2026-03-02", { approvedBy: biz.admin.id }),
    audit("update_product", "2026-03-02", {}),
  ]);
});

afterAll(releaseDevices);

async function runAll() {
  const db = device.db!;
  const out: Record<string, unknown> = {};
  for (const [label, from, to, storeId] of [
    ["TVA mars", "2026-03-01", "2026-03-31", undefined],
    ["TVA mars boutique", "2026-03-01", "2026-03-31", biz.storeId],
    ["TVA mars autre boutique", "2026-03-01", "2026-03-31", otherStore],
    ["TVA un jour", "2026-03-02", "2026-03-02", undefined],
    ["TVA février", "2026-02-01", "2026-02-28", undefined],
    ["TVA vide", "2027-01-01", "2027-01-31", undefined],
  ] as const) {
    out[label] = await getTaxCollected(db, { from, to }, storeId);
  }
  for (const [label, day, storeId] of [
    ["jour", "2026-03-02", undefined],
    ["jour boutique", "2026-03-02", biz.storeId],
    ["jour autre boutique", "2026-03-02", otherStore],
    ["lendemain", "2026-03-03", undefined],
    ["jour vide", "2026-03-10", undefined],
  ] as const) {
    out[`résumé ${label}`] = await getDailySummary(db, day, storeId);
  }
  // Tirage déterministe sur tout l'historique.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  out["vérification"] = await getVerificationSample(db, { days: 100000, count: 10, random });
  out["vérification boutique"] = await getVerificationSample(db, { days: 100000, count: 10, storeId: biz.storeId, random });
  return out;
}

describe("TVA et résumé du jour = ancienne implémentation", () => {
  it("instantané (capture avec CAPTURE_READS=1 sur l'ancien code)", async () => {
    const got = JSON.parse(JSON.stringify(await runAll()));
    // Les « alertes » dépendent de la date du jour (ancienneté des tickets) : on ne compare que leur nombre via le résumé.
    if (process.env.CAPTURE_READS) {
      writeFileSync(SNAPSHOT, JSON.stringify(got, null, 1));
      return;
    }
    expect(existsSync(SNAPSHOT)).toBe(true);
    expect(got).toEqual(JSON.parse(readFileSync(SNAPSHOT, "utf-8")));
  });

  it("le jeu de données couvre les cas visés", async () => {
    const out = JSON.parse(JSON.stringify(await runAll())) as Record<string, any>;
    expect(out["TVA mars"].refundsTaxTotal).toBe(285); // 90 + 15 + 180 (remboursement d'une vente de février)
    expect(out["TVA février"].totalTaxCollected).toBe(360);
    expect(out["résumé jour"].ticketsCount).toBe(2); // annulé et autre jour exclus... + autre boutique inclus (toutes boutiques)
    expect(out["résumé jour boutique"].cashSessionsClosed).toBe(1);
    expect(out["résumé jour"].discountCount).toBe(2);
    expect(out["vérification"].items.length).toBeGreaterThan(0);
  });
});
