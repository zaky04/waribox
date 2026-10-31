import { schema } from "@gestion-boutique/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, type TestDevice } from "../test/testDb";
import { getSalesSummary } from "./ReportsService";

// getSalesSummary filtre maintenant en SQL ; ce test le compare, sur des données
// variées (plusieurs jours, boutiques, vendeurs, remboursements hors période), à
// un calcul de référence volontairement naïf fait en JavaScript sur les lignes brutes.

let device: TestDevice;
let biz: SeededBusiness;
let otherStoreId: number;

const at = (day: string, time = "10:00:00") => `${day} ${time}`;

beforeAll(async () => {
  device = await createDevice("summary");
  biz = await seedBusiness(device.db!);
  const db = device.db!;
  otherStoreId = (await db.insert(schema.stores).values({ name: "Autre boutique" }).returning().get()).id;

  const mk = (n: number, day: string, total: number, userId: number, storeId: number, time?: string) => ({
    number: `VTE-T-${n}`,
    userId,
    storeId,
    saleMode: "pos",
    subtotal: total,
    discount: 0,
    taxTotal: 0,
    total,
    paymentStatus: "paid",
    createdAt: at(day, time),
  });
  const sales = await db
    .insert(schema.sales)
    .values([
      mk(1, "2026-03-01", 1000, biz.admin.id, biz.storeId),
      mk(2, "2026-03-01", 2500, biz.cashier.id, biz.storeId, "23:59:59"),
      mk(3, "2026-03-02", 4000, biz.admin.id, otherStoreId),
      mk(4, "2026-03-03", 700, biz.cashier.id, biz.storeId, "00:00:00"),
      mk(5, "2026-03-05", 9000, biz.admin.id, biz.storeId),
    ])
    .returning();
  const byNumber = (n: number) => sales.find((s) => s.number === `VTE-T-${n}`)!;
  // Remboursements : un dans la période d'une vente plus ancienne, un sur une autre boutique, un hors période.
  await db.insert(schema.refunds).values([
    { saleId: byNumber(1).id, userId: biz.admin.id, reason: "r", method: "cash", subtotal: 300, taxTotal: 0, total: 300, createdAt: at("2026-03-03") },
    { saleId: byNumber(3).id, userId: biz.admin.id, reason: "r", method: "cash", subtotal: 1000, taxTotal: 0, total: 1000, createdAt: at("2026-03-03") },
    { saleId: byNumber(5).id, userId: biz.cashier.id, reason: "r", method: "cash", subtotal: 500, taxTotal: 0, total: 500, createdAt: at("2026-04-20") },
  ]);
});

afterAll(releaseDevices);

// Référence naïve : tout relire, tout filtrer en JavaScript.
async function reference(from: string, to: string, storeId?: number, userId?: number) {
  const db = device.db!;
  const f = from.length === 10 ? `${from} 00:00:00` : from;
  const t = to.length === 10 ? `${to} 23:59:59` : to;
  const sales = await db.select().from(schema.sales);
  const refunds = await db.select().from(schema.refunds);
  const inRange = (d: string) => d >= f && d <= t;
  const mine = sales.filter((s) => inRange(s.createdAt) && (!storeId || s.storeId === storeId) && (!userId || s.userId === userId));
  let revenue = mine.reduce((n, s) => n + s.total, 0);
  const byDay = new Map<string, number>();
  for (const s of mine) byDay.set(s.createdAt.slice(0, 10), (byDay.get(s.createdAt.slice(0, 10)) ?? 0) + s.total);
  for (const r of refunds) {
    const sale = sales.find((s) => s.id === r.saleId);
    if (!sale || !inRange(r.createdAt)) continue;
    if (storeId && sale.storeId !== storeId) continue;
    if (userId && sale.userId !== userId) continue;
    revenue -= r.total;
    byDay.set(r.createdAt.slice(0, 10), (byDay.get(r.createdAt.slice(0, 10)) ?? 0) - r.total);
  }
  return {
    totalRevenue: revenue,
    saleCount: mine.length,
    byDay: [...byDay.entries()].map(([date, total]) => ({ date, total })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

describe("getSalesSummary (filtre SQL) = référence naïve", () => {
  const cases: Array<[string, string, "all" | "store" | "user" | "both"]> = [
    ["2026-03-01", "2026-03-01", "all"],
    ["2026-03-01", "2026-03-05", "all"],
    ["2026-03-01", "2026-03-05", "store"],
    ["2026-03-01", "2026-03-05", "user"],
    ["2026-03-01", "2026-03-05", "both"],
    ["2026-03-03", "2026-03-03", "all"], // seulement des remboursements d'anciennes ventes + une vente à minuit pile
    ["2026-03-04", "2026-03-04", "all"], // jour vide
    ["2026-04-01", "2026-04-30", "all"], // période avec uniquement un remboursement
    ["2026-03-01 10:00:00", "2026-03-02 23:59:59", "all"], // bornes avec heure
  ];
  for (const [from, to, scope] of cases) {
    it(`${from} → ${to} (${scope})`, async () => {
      const storeId = scope === "store" || scope === "both" ? biz.storeId : undefined;
      const userId = scope === "user" || scope === "both" ? biz.cashier.id : undefined;
      const got = await getSalesSummary(device.db!, { from, to }, storeId, userId);
      const want = await reference(from, to, storeId, userId);
      expect(got.totalRevenue).toBe(want.totalRevenue);
      expect(got.saleCount).toBe(want.saleCount);
      expect(got.byDay).toEqual(want.byDay);
      expect(got.averageBasket).toBe(want.saleCount > 0 ? want.totalRevenue / want.saleCount : 0);
    });
  }

  it("une vente à 23:59:59 compte dans le jour, une à 00:00:00 aussi", async () => {
    const s = await getSalesSummary(device.db!, { from: "2026-03-01", to: "2026-03-01" }, biz.storeId);
    expect(s.saleCount).toBe(2);
    const next = await getSalesSummary(device.db!, { from: "2026-03-03", to: "2026-03-03" }, biz.storeId);
    expect(next.saleCount).toBe(1);
  });
});
