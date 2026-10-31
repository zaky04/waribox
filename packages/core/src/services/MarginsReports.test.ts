import { schema } from "@gestion-boutique/database";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, type TestDevice } from "../test/testDb";
import { getMarginsSummary, getProductMarginsBreakdown, getTopProducts } from "./ReportsService";

// Les rapports de marge et « meilleurs produits » ont été réécrits pour filtrer en SQL
// au lieu de relire toutes les ventes. Ce test compare leur sortie, sur un jeu de
// données varié, à un instantané pris avec l'ANCIENNE implémentation :
//   CAPTURE_MARGINS=1 pnpm --filter @gestion-boutique/core exec vitest run src/services/MarginsReports.test.ts
const SNAPSHOT = join(__dirname, "MarginsReports.snapshot.json");

let device: TestDevice;
let biz: SeededBusiness;

const at = (day: string, time = "10:00:00") => `${day} ${time}`;

const RANGES: Array<{ label: string; from: string; to: string; scope: "all" | "main" | "other" }> = [
  { label: "mars", from: "2026-03-01", to: "2026-03-31", scope: "all" },
  { label: "mars boutique principale", from: "2026-03-01", to: "2026-03-31", scope: "main" },
  { label: "mars autre boutique", from: "2026-03-01", to: "2026-03-31", scope: "other" },
  { label: "année", from: "2026-01-01", to: "2026-12-31", scope: "all" },
  { label: "février", from: "2026-02-01", to: "2026-02-28", scope: "all" },
  { label: "avril (remboursement seul)", from: "2026-04-01", to: "2026-04-30", scope: "all" },
  { label: "jour de remboursement d'ancienne vente", from: "2026-03-06", to: "2026-03-06", scope: "all" },
  { label: "remboursement d'une ancienne vente à deux lignes", from: "2026-03-07", to: "2026-03-07", scope: "all" },
  { label: "vide", from: "2027-01-01", to: "2027-01-31", scope: "all" },
];

let otherStoreId: number;

beforeAll(async () => {
  device = await createDevice("margins");
  biz = await seedBusiness(device.db!);
  const db = device.db!;
  otherStoreId = (await db.insert(schema.stores).values({ name: "Autre boutique" }).returning().get()).id;

  type Id = { id: number };
  const [p1, p2, p3] = (await db
    .insert(schema.products)
    .values([
      { name: "Produit A", purchasePrice: 100, salePrice: 300 },
      { name: "Produit B", purchasePrice: 50, salePrice: 100 },
      { name: "Produit C", purchasePrice: 70, salePrice: 200 },
    ])
    .returning()) as unknown as [Id, Id, Id];
  const [v1, v2, v3, v4] = (await db
    .insert(schema.productVariants)
    .values([
      { productId: p1.id, sku: "A1" },
      { productId: p1.id, sku: "A2" },
      { productId: p2.id, sku: "B1" },
      { productId: p3.id, sku: "C1" },
    ])
    .returning()) as unknown as [Id, Id, Id, Id];
  const [b1, b2, b3] = (await db
    .insert(schema.stockBatches)
    .values([
      { variantId: v1.id, locationId: biz.locations.surface, quantity: 50, unitCost: 120 },
      { variantId: v1.id, locationId: biz.locations.surface, quantity: 50, unitCost: 90 },
      { variantId: v3.id, locationId: biz.locations.surface, quantity: 50, unitCost: null },
    ])
    .returning()) as unknown as [Id, Id, Id];

  const mk = (n: number, day: string, total: number, storeId: number) => ({
    number: `VTE-M-${n}`,
    userId: biz.admin.id,
    storeId,
    saleMode: "pos",
    subtotal: total,
    discount: 0,
    taxTotal: 0,
    total,
    paymentStatus: "paid",
    createdAt: at(day),
  });
  const sales = await db
    .insert(schema.sales)
    .values([
      mk(1, "2026-03-01", 1180, biz.storeId),
      mk(2, "2026-03-02", 400, otherStoreId),
      mk(3, "2026-02-10", 1500, biz.storeId),
      mk(4, "2026-03-04", 200, biz.storeId),
      mk(5, "2026-03-05", 1000, biz.storeId),
      mk(6, "2026-02-15", 1500, biz.storeId),
    ])
    .returning();
  const s = (n: number) => sales.find((x) => x.number === `VTE-M-${n}`)!;

  const items = await db
    .insert(schema.saleItems)
    .values([
      // Même variante sur deux lignes d'une même vente (coût réparti au prorata).
      { saleId: s(1).id, variantId: v1.id, quantity: 2, unitPrice: 300, discount: 0, total: 600 },
      { saleId: s(1).id, variantId: v1.id, quantity: 1, unitPrice: 300, discount: 20, total: 280 },
      { saleId: s(1).id, variantId: v2.id, quantity: 1, unitPrice: 300, discount: 0, total: 300 },
      { saleId: s(2).id, variantId: v3.id, quantity: 4, unitPrice: 100, discount: 0, total: 400 },
      { saleId: s(3).id, variantId: v1.id, quantity: 5, unitPrice: 300, discount: 0, total: 1500 },
      { saleId: s(4).id, variantId: v4.id, quantity: 1, unitPrice: 200, discount: 0, total: 200 },
      { saleId: s(5).id, variantId: v2.id, quantity: 2, unitPrice: 500, discount: 0, total: 1000 },
      // Ancienne vente avec deux lignes de la même variante, dont une sera remboursée en mars.
      { saleId: s(6).id, variantId: v1.id, quantity: 2, unitPrice: 300, discount: 0, total: 600 },
      { saleId: s(6).id, variantId: v1.id, quantity: 3, unitPrice: 300, discount: 0, total: 900 },
    ])
    .returning();
  const item = (saleNumber: number, idx = 0) => items.filter((i) => i.saleId === s(saleNumber).id)[idx]!;

  const mv = (saleNumber: number, variantId: number, qty: number, batchId: number | null) => ({
    variantId,
    locationId: biz.locations.surface,
    batchId,
    quantityDelta: -qty,
    movementType: "sale",
    referenceType: "sale",
    referenceId: s(saleNumber).id,
    createdAt: at("2026-03-01"),
  });
  await db.insert(schema.stockMovements).values([
    mv(1, v1.id, 2, b1.id),
    mv(1, v1.id, 1, b2.id),
    mv(1, v2.id, 1, null), // pas de lot : repli sur le prix d'achat du produit
    mv(2, v3.id, 4, b3.id), // lot sans coût : repli sur le prix d'achat
    mv(3, v1.id, 5, b2.id),
    // la vente 4 n'a aucun mouvement de stock
    mv(5, v2.id, 2, null),
    mv(6, v1.id, 5, b1.id),
    // Un retour en stock et un mouvement manuel ne comptent pas comme coût de vente.
    { variantId: v1.id, locationId: biz.locations.surface, batchId: b1.id, quantityDelta: 1, movementType: "return", referenceType: "sale", referenceId: s(1).id, createdAt: at("2026-03-03") },
    { variantId: v1.id, locationId: biz.locations.surface, batchId: b1.id, quantityDelta: -3, movementType: "loss", referenceType: "manual", referenceId: null, createdAt: at("2026-03-03") },
  ]);

  const refunds = await db
    .insert(schema.refunds)
    .values([
      { saleId: s(1).id, userId: biz.admin.id, reason: "r", method: "cash", subtotal: 300, taxTotal: 0, total: 300, createdAt: at("2026-03-03") },
      { saleId: s(2).id, userId: biz.admin.id, reason: "r", method: "cash", subtotal: 200, taxTotal: 0, total: 200, createdAt: at("2026-03-03") },
      { saleId: s(3).id, userId: biz.admin.id, reason: "r", method: "cash", subtotal: 600, taxTotal: 0, total: 600, createdAt: at("2026-03-06") },
      { saleId: s(5).id, userId: biz.admin.id, reason: "r", method: "cash", subtotal: 500, taxTotal: 0, total: 500, createdAt: at("2026-04-02") },
      { saleId: s(6).id, userId: biz.admin.id, reason: "r", method: "cash", subtotal: 300, taxTotal: 0, total: 300, createdAt: at("2026-03-07") },
    ])
    .returning();
  await db.insert(schema.refundItems).values([
    { refundId: refunds[0]!.id, saleItemId: item(1, 0).id, quantity: 1, unitPrice: 300, total: 300, restocked: true },
    { refundId: refunds[1]!.id, saleItemId: item(2).id, quantity: 2, unitPrice: 100, total: 200, restocked: false },
    { refundId: refunds[2]!.id, saleItemId: item(3).id, quantity: 2, unitPrice: 300, total: 600, restocked: true },
    { refundId: refunds[3]!.id, saleItemId: item(5).id, quantity: 1, unitPrice: 500, total: 500, restocked: true },
    { refundId: refunds[4]!.id, saleItemId: item(6, 1).id, quantity: 1, unitPrice: 300, total: 300, restocked: true },
  ]);
});

afterAll(releaseDevices);

async function runAll() {
  const out: Record<string, unknown> = {};
  for (const r of RANGES) {
    const storeId = r.scope === "main" ? biz.storeId : r.scope === "other" ? otherStoreId : undefined;
    const range = { from: r.from, to: r.to };
    out[r.label] = {
      margins: await getMarginsSummary(device.db!, range, storeId),
      breakdown: await getProductMarginsBreakdown(device.db!, range, storeId),
      top: await getTopProducts(device.db!, range, 10, storeId),
    };
  }
  return out;
}

describe("rapports de marge et meilleurs produits = ancienne implémentation", () => {
  it("instantané (capture avec CAPTURE_MARGINS=1 sur l'ancien code)", async () => {
    const got = await runAll();
    if (process.env.CAPTURE_MARGINS) {
      writeFileSync(SNAPSHOT, JSON.stringify(got, null, 1));
      return;
    }
    expect(existsSync(SNAPSHOT)).toBe(true);
    expect(JSON.parse(JSON.stringify(got))).toEqual(JSON.parse(readFileSync(SNAPSHOT, "utf-8")));
  });

  it("le jeu de données couvre bien les cas visés", async () => {
    const snap = await runAll();
    const march = snap["mars"] as { margins: { revenue: number; cost: number }; breakdown: unknown[]; top: unknown[] };
    expect(march.breakdown.length).toBeGreaterThan(2);
    expect(march.margins.cost).toBeGreaterThan(0);
    // Remboursement d'une ancienne vente (février) imputé à mars.
    const refundDay = snap["jour de remboursement d'ancienne vente"] as { margins: { revenue: number } };
    expect(refundDay.margins.revenue).toBe(-600);
    // Mois sans vente mais avec un remboursement.
    const april = snap["avril (remboursement seul)"] as { margins: { revenue: number } };
    expect(april.margins.revenue).toBe(-500);
  });
});
