import { schema } from "@gestion-boutique/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, useDevice, type TestDevice } from "../test/testDb";
import { buildAccountantExport, localDateTime } from "./AccountantExportService";
import { createExpense } from "./ExpensesService";
import { createProduct } from "./ProductsService";
import { createSale } from "./SalesService";
import { addManualStockEntry } from "./StockService";

describe("dossier pour l'expert-comptable", () => {
  let device: TestDevice;
  let biz: SeededBusiness;
  let variantId = 0;
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  beforeAll(async () => {
    device = await createDevice("accountant");
    biz = await seedBusiness(device.db!);
    const p = await createProduct(device.db!, { name: "Riz", purchasePrice: 600, salePrice: 1000, createdBy: biz.admin.id }, biz.admin.permissions);
    variantId = p.defaultVariant.id;
    await addManualStockEntry(device.db!, { variantId, locationId: biz.locations.surface, quantity: 30, note: "départ", userId: biz.admin.id }, biz.admin.permissions);
    const sale = (qty: number, extra: Record<string, unknown> = {}) =>
      createSale(device.db!, { userId: biz.admin.id, saleMode: "pos", items: [{ variantId, quantity: qty, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId, ...extra }, biz.admin.permissions);
    await sale(2);
    await sale(3, { paymentMethod: "mobile_money" });
    await sale(1, { paymentMethod: "credit", amountPaid: 0, newCustomerName: "Awa Koné" });
    await createExpense(device.db!, { category: "Loyer", amount: 50000, expenseDate: day, paymentMethod: "cash", userId: biz.admin.id, note: "novembre" }, biz.admin.permissions);
  });
  afterAll(releaseDevices);

  const sheet = (exportData: Awaited<ReturnType<typeof buildAccountantExport>>, name: string) => exportData.sheets.find((s) => s.name === name)!;

  it("une feuille par type de pièce, une ligne par opération, montants et modes de paiement exacts", async () => {
    useDevice(device);
    const data = await buildAccountantExport(device.db!, { from: day, to: day });
    expect(data.sheets.map((s) => s.name)).toEqual(["Résumé", "Ventes", "Remboursements", "Achats", "Dépenses", "Règlements clients", "Créances ouvertes", "TVA par jour"]);

    const sales = sheet(data, "Ventes").rows;
    expect(sales.map((r) => r["Total TTC"])).toEqual([2000, 3000, 1000]);
    expect(sales.map((r) => r["Mode de paiement"])).toEqual(["Espèces", "Mobile Money", "Crédit"]);
    expect(sales[2]!["Client"]).toBe("Awa Koné");
    expect(sales[0]!["Numéro"]).toMatch(/^VTE-\d{4}-\d{6}$/);
    expect(String(sales[0]!["Date"])).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const expenses = sheet(data, "Dépenses").rows;
    expect(expenses).toEqual([{ Date: day, "Catégorie": "Loyer", Note: "novembre", Montant: 50000, "Mode de paiement": "Espèces" }]);

    const openCredits = sheet(data, "Créances ouvertes").rows;
    expect(openCredits.length).toBe(1);
    expect(openCredits[0]).toMatchObject({ Client: "Awa Koné", "Reste dû": 1000 });
  });

  it("le résumé concorde avec les feuilles", async () => {
    useDevice(device);
    const data = await buildAccountantExport(device.db!, { from: day, to: day });
    const summary = Object.fromEntries(sheet(data, "Résumé").rows.map((r) => [r["Libellé"], r["Montant"]]));
    expect(summary["Ventes (TTC)"]).toBe(6000);
    expect(summary["Remboursements"]).toBe(0);
    expect(summary["Ventes nettes"]).toBe(6000);
    expect(summary["Dépenses"]).toBe(50000);
    expect(summary["Créances clients restant dues (aujourd'hui)"]).toBe(1000);
    expect(summary["Période"]).toBe(`${day} → ${day}`);
  });

  it("une période sans activité donne des feuilles vides, pas d'erreur ; une boutique sans activité aussi", async () => {
    useDevice(device);
    const empty = await buildAccountantExport(device.db!, { from: "2020-01-01", to: "2020-01-31" });
    expect(sheet(empty, "Ventes").rows).toEqual([]);
    expect(sheet(empty, "Dépenses").rows).toEqual([]);
    const otherStore = await buildAccountantExport(device.db!, { from: day, to: day }, 999);
    expect(sheet(otherStore, "Ventes").rows).toEqual([]);
  });

  it("les dates sont en heure locale", () => {
    const utc = "2026-11-20 23:30:00";
    const local = new Date("2026-11-20T23:30:00Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(localDateTime(utc)).toBe(`${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`);
    expect(localDateTime(null)).toBe("");
    expect(localDateTime("n'importe quoi")).toBe("n'importe quoi");
    expect(schema.sales).toBeDefined();
  });
});
