import { schema } from "@gestion-boutique/database";
import { WsMessage, WsMessageTypes } from "@gestion-boutique/network";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct } from "../services/ProductsService";
import { createSale } from "../services/SalesService";
import { addManualStockEntry, getStockLevels } from "../services/StockService";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, useDevice, type TestDevice } from "../test/testDb";
import { createMasterProtocol, type MasterProtocol } from "./masterProtocol";
import { applyCatalogSnapshot, type CatalogSnapshot } from "./snapshot";
import { onSyncEvent, type SyncEvent } from "./syncEvents";

// Parcours réel d'une vente faite sur un appareil relié, hors ligne, puis
// remontée au Maître — avec de vraies bases, de vraies ventes, du vrai stock.

let master: TestDevice;
let worker: TestDevice;
let biz: SeededBusiness;
let protocol: MasterProtocol;
let toWorker: WsMessage[] = [];
let variantId: number;

async function capture(run: () => Promise<unknown>): Promise<SyncEvent[]> {
  const events: SyncEvent[] = [];
  const off = onSyncEvent((e) => events.push(e));
  try {
    await run();
  } finally {
    off();
  }
  return events;
}

async function sendToMaster(event: SyncEvent): Promise<WsMessage> {
  useDevice(master);
  toWorker = [];
  const message = new WsMessage({ type: WsMessageTypes.sync, payload: { event } });
  await protocol.handleMessage("c1", message.encode());
  await protocol.idle();
  return toWorker.find((m) => m.correlationId === message.correlationId)!;
}

const saleInput = (quantity: number, userId: number) => ({
  userId,
  saleMode: "pos" as const,
  items: [{ variantId, quantity, unitPrice: 1000 }],
  paymentMethod: "cash" as const,
  surfaceLocationId: biz.locations.surface,
  storeId: biz.storeId,
});

beforeAll(async () => {
  master = await createDevice("master");
  biz = await seedBusiness(master.db!);
  const created = await createProduct(master.db!, { name: "Savon", purchasePrice: 400, salePrice: 1000, createdBy: biz.admin.id }, biz.admin.permissions);
  variantId = created.defaultVariant.id;
  await addManualStockEntry(master.db!, { variantId, locationId: biz.locations.surface, quantity: 50, userId: biz.admin.id, note: "stock initial" }, biz.admin.permissions);

  protocol = createMasterProtocol({
    db: master.db!,
    masterId: "m",
    masterName: "Maître",
    send: (_id, m) => {
      toWorker.push(m);
    },
  });
  await protocol.handleMessage("c1", new WsMessage({ type: WsMessageTypes.hello, payload: { deviceId: "tel", deviceName: "Tel" } }).encode());
  await protocol.idle();
  const snapshot = toWorker.find((m) => m.type === WsMessageTypes.snapshotResponse)!.payload.snapshot as CatalogSnapshot;

  worker = await createDevice("worker");
  await applyCatalogSnapshot(worker.db!, snapshot);
});

afterAll(releaseDevices);

describe("numérotation des documents", () => {
  it("la vente d'un appareil relié, faite hors ligne, remonte au Maître même si son numéro existe déjà là-bas", async () => {
    // Le Maître vend trois fois : VTE-…-000001 à 000003.
    useDevice(master);
    for (let i = 0; i < 3; i++) await createSale(master.db!, saleInput(1, biz.admin.id), biz.admin.permissions);
    const masterNumbers = (await master.db!.select({ n: schema.sales.number }).from(schema.sales)).map((r) => r.n);
    expect(masterNumbers).toHaveLength(3);

    // L'appareil relié (qui n'a reçu aucune de ces ventes) vend de son côté : même compteur local.
    useDevice(worker);
    await addManualStockEntry(worker.db!, { variantId, locationId: biz.locations.surface, quantity: 20, userId: biz.admin.id, note: "stock local" }, biz.admin.permissions);
    const events = await capture(() => createSale(worker.db!, saleInput(2, biz.admin.id), biz.admin.permissions));
    const saleEvent = events.find((e) => e.type === "sale.created")!;
    const workerNumber = (saleEvent.payload as { sale: { number: string } }).sale.number;
    expect(masterNumbers).toContain(workerNumber); // la collision est bien réelle

    const reply = await sendToMaster(saleEvent);
    expect(reply.type).toBe(WsMessageTypes.syncAck);

    useDevice(master);
    const all = await master.db!.select().from(schema.sales);
    expect(all).toHaveLength(4);
    expect(new Set(all.map((s) => s.number)).size).toBe(4); // tous uniques
    const received = all.find((s) => s.syncId === (saleEvent.payload as { sale: { syncId: string } }).sale.syncId)!;
    expect(received.number.startsWith(workerNumber)).toBe(true); // numéro d'origine reconnaissable
    expect(received.total).toBe(2000);
  });

  it("le stock du Maître reflète la vente reçue", async () => {
    useDevice(master);
    const levels = await getStockLevels(master.db!, biz.storeId);
    const surface = levels.filter((l) => l.variantId === variantId && l.locationId === biz.locations.surface);
    expect(surface.reduce((n, l) => n + l.quantity, 0)).toBe(50 - 3 - 2);
  });

  it("la suite de numéros repart de 1 chaque année et ne réutilise jamais un numéro", async () => {
    useDevice(master);
    const year = new Date().getFullYear();
    const next = await createSale(master.db!, saleInput(1, biz.admin.id), biz.admin.permissions);
    // 3 ventes du Maître + 1 reçue (numéro suffixé) : la suivante ne doit pas retomber sur un numéro pris.
    const numbers = (await master.db!.select({ n: schema.sales.number }).from(schema.sales)).map((r) => r.n);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(next.number.startsWith(`VTE-${year}-`)).toBe(true);

    // Une vente supprimée au milieu ne fait pas réutiliser un numéro.
    await master.db!.delete(schema.sales).where(eq(schema.sales.number, `VTE-${year}-000002`)).run().catch(() => undefined);
    const after = await createSale(master.db!, saleInput(1, biz.admin.id), biz.admin.permissions);
    expect(numbers).not.toContain(after.number);
  });
});
