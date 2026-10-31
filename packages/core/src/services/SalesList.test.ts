import { schema } from "@gestion-boutique/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, type TestDevice } from "../test/testDb";
import { listSalePayments, listSales } from "./SalesService";

let device: TestDevice;
let biz: SeededBusiness;
let ids: number[] = [];

beforeAll(async () => {
  device = await createDevice("saleslist");
  biz = await seedBusiness(device.db!);
  const db = device.db!;
  const rows = Array.from({ length: 1300 }, (_, n) => ({
    number: `VTE-L-${n}`,
    userId: biz.admin.id,
    storeId: biz.storeId,
    saleMode: "pos",
    subtotal: 100,
    discount: 0,
    taxTotal: 0,
    total: 100,
    paymentStatus: "paid",
    createdAt: "2026-05-01 10:00:00",
  }));
  for (let i = 0; i < rows.length; i += 400) {
    const created = await db.insert(schema.sales).values(rows.slice(i, i + 400)).returning();
    ids.push(...created.map((s) => s.id));
  }
  // Une vente sur trois en espèces, les autres par carte ; une vente sans paiement.
  const payments = ids.slice(0, -1).map((id, n) => ({ referenceType: "sale", referenceId: id, method: n % 3 === 0 ? "cash" : "card", amount: 100 }));
  for (let i = 0; i < payments.length; i += 400) await db.insert(schema.payments).values(payments.slice(i, i + 400));
  // Un règlement de créance ne doit pas être pris pour le paiement de la vente.
  await db.insert(schema.payments).values({ referenceType: "credit_repayment", referenceId: ids[0]!, method: "cash", amount: 5 });
});

afterAll(releaseDevices);

describe("listSales : pagination et filtre de paiement", () => {
  it("renvoie les plus récentes d'abord, page après page, sans trou ni doublon", async () => {
    const all = await listSales(device.db!);
    const pages = [
      ...(await listSales(device.db!, { limit: 500, offset: 0 })),
      ...(await listSales(device.db!, { limit: 500, offset: 500 })),
      ...(await listSales(device.db!, { limit: 500, offset: 1000 })),
    ];
    expect(all).toHaveLength(1300);
    expect(pages.map((s) => s.id)).toEqual(all.map((s) => s.id));
    expect(all[0]!.id).toBeGreaterThan(all[1]!.id);
  });

  it("une page plus grande que le reste renvoie ce qui reste", async () => {
    expect(await listSales(device.db!, { limit: 100, offset: 1250 })).toHaveLength(50);
    expect(await listSales(device.db!, { limit: 100, offset: 5000 })).toHaveLength(0);
  });

  it("le filtre par mode de paiement fonctionne au-delà de 999 ventes (sous-requête)", async () => {
    const cash = await listSales(device.db!, { paymentMethod: "cash" });
    const card = await listSales(device.db!, { paymentMethod: "card" });
    expect(cash).toHaveLength(Math.ceil(1299 / 3));
    expect(cash.length + card.length).toBe(1299);
    expect(await listSales(device.db!, { paymentMethod: "mobile_money" })).toHaveLength(0);
    // Combiné à la pagination.
    expect(await listSales(device.db!, { paymentMethod: "card", limit: 10 })).toHaveLength(10);
  });

  it("listSalePayments(ids) ne renvoie que les paiements de vente demandés", async () => {
    const some = await listSalePayments(device.db!, [ids[0]!, ids[1]!, ids[1299]!]);
    // ids[1299] n'a pas de paiement ; le règlement de créance de ids[0] est exclu.
    expect(some.map((p) => p.referenceId).sort((a, b) => a - b)).toEqual([ids[0]!, ids[1]!]);
    const many = await listSalePayments(device.db!, ids);
    expect(many).toHaveLength(1299);
    expect(await listSalePayments(device.db!, [])).toEqual([]);
  });
});
