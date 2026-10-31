import { schema } from "@gestion-boutique/database";
import { WsMessage, WsMessageTypes } from "@gestion-boutique/network";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCustomer } from "../services/CustomersService";
import { createProduct } from "../services/ProductsService";
import { createPurchase } from "../services/PurchasesService";
import { createSupplier } from "../services/SuppliersService";
import { createSale } from "../services/SalesService";
import { addManualStockEntry, getStockLevels } from "../services/StockService";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, useDevice, type TestDevice } from "../test/testDb";
import { createMasterProtocol, type MasterProtocol } from "./masterProtocol";
import { onSyncEvent, type SyncEvent } from "./syncEvents";
import { enqueueOutbox, getCatalogHashes, getLastAppliedSeq, listPendingOutbox, markOutboxSent } from "./syncStore";
import { createWorkerSync, type WorkerSync } from "./workerSync";

// Maître et appareil relié complets (deux vraies bases SQLite, le vrai protocole des deux côtés), reliés
// par un « réseau » en mémoire : on y vérifie que l'appareil relié SUIT le Maître après l'appairage —
// stock de départ, produits et clients créés ensuite, achats faits sur le Maître, événements arrivés avant
// leur catalogue — et que rien ne se perd ni ne se double.

const CONN = "conn-w1";

let master: TestDevice;
let worker: TestDevice;
let biz: SeededBusiness;
let protocol: MasterProtocol;
let sync: WorkerSync;
let toWorker: WsMessage[] = [];
let toMaster: WsMessage[] = [];
const outboxByCorrelation = new Map<string, number>();
let applyError: string | null = null;
const applyErrorsSeen: string[] = [];

async function deliverToMaster() {
  while (toMaster.length > 0) {
    const m = toMaster.shift()!;
    useDevice(master);
    await protocol.handleMessage(CONN, m.encode());
    await protocol.idle();
  }
}

async function deliverToWorker() {
  while (toWorker.length > 0) {
    const m = toWorker.shift()!;
    useDevice(worker);
    if (m.type === WsMessageTypes.syncAck) {
      const outboxId = outboxByCorrelation.get(m.correlationId);
      if (outboxId != null) await markOutboxSent(worker.db!, outboxId);
      await sync.noteAck(m.payload.seq);
    } else {
      sync.handleMessage(m);
    }
    await sync.idle();
  }
}

/** Fait circuler les trames dans les deux sens jusqu'à ce que plus rien ne bouge. */
async function pump() {
  for (let i = 0; i < 20; i++) {
    if (toMaster.length === 0 && toWorker.length === 0) return;
    await deliverToMaster();
    await deliverToWorker();
  }
}

/** Exécute une action sur un appareil et route les événements qu'elle émet, comme le fait l'application. */
async function act<T>(device: TestDevice, run: () => Promise<T>): Promise<T> {
  useDevice(device);
  const events: SyncEvent[] = [];
  const off = onSyncEvent((e) => events.push(e));
  let result: T;
  try {
    result = await run();
  } finally {
    off();
  }
  if (device === master) {
    for (const e of events) await protocol.broadcastLocalEvent(e);
  } else {
    for (const e of events) {
      sync.noteLocalEvent();
      useDevice(worker);
      const outboxId = await enqueueOutbox(worker.db!, e);
      const msg = new WsMessage({ type: WsMessageTypes.sync, payload: { event: e } });
      outboxByCorrelation.set(msg.correlationId, outboxId);
      toMaster.push(msg);
    }
  }
  await pump();
  return result;
}

const stockOf = async (device: TestDevice, variantId: number, locationId?: number) => {
  useDevice(device);
  const levels = await getStockLevels(device.db!, biz.storeId);
  return levels.filter((l) => l.variantId === variantId && (locationId == null || l.locationId === locationId)).reduce((n, l) => n + l.quantity, 0);
};

const saleOn = (device: TestDevice, variantId: number, extra: Record<string, unknown> = {}) =>
  act(device, () =>
    createSale(
      device.db!,
      { userId: biz.admin.id, saleMode: "pos", items: [{ variantId, quantity: 1, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId, ...extra },
      biz.admin.permissions,
    ),
  );

/** Le Maître prévient (changement de catalogue), l'appareil relié redemande, tout circule. */
async function syncWorker() {
  useDevice(master);
  await protocol.checkCatalogChanged();
  await pump();
  useDevice(worker);
  await sync.requestRefresh();
  await pump();
}

let variantA = 0;

beforeAll(async () => {
  master = await createDevice("master");
  biz = await seedBusiness(master.db!);
  worker = await createDevice("worker");

  protocol = createMasterProtocol({
    db: master.db!,
    masterId: "m1",
    masterName: "Maître",
    send: (_id, message) => {
      toWorker.push(message);
    },
  });
  sync = createWorkerSync({
    db: worker.db!,
    send: (message) => {
      toMaster.push(message);
      return true;
    },
    onApplyError: (reason) => {
      applyError = reason;
      if (reason) applyErrorsSeen.push(reason);
    },
  });

  // Avant l'appairage : un produit avec du stock en réserve et en surface, sur le Maître.
  useDevice(master);
  const a = await createProduct(master.db!, { name: "Produit A", purchasePrice: 400, salePrice: 1000, createdBy: biz.admin.id }, biz.admin.permissions);
  variantA = a.defaultVariant.id;
  await addManualStockEntry(master.db!, { variantId: variantA, locationId: biz.locations.surface, quantity: 5, expiryDate: "2030-01-01", note: "départ", userId: biz.admin.id }, biz.admin.permissions);
  await addManualStockEntry(master.db!, { variantId: variantA, locationId: biz.locations.reserve, quantity: 7, note: "départ", userId: biz.admin.id }, biz.admin.permissions);

  // Premier appairage.
  toMaster.push(new WsMessage({ type: WsMessageTypes.hello, payload: { deviceId: "tel-1", deviceName: "Tablette" } }));
  await pump();
});

afterAll(releaseDevices);

describe("premier appairage", () => {
  it("l'appareil relié voit tout de suite le stock du Maître (avant : 0 partout)", async () => {
    expect(await stockOf(worker, variantA, biz.locations.surface)).toBe(5);
    expect(await stockOf(worker, variantA, biz.locations.reserve)).toBe(7);
    useDevice(worker);
    expect(await getLastAppliedSeq(worker.db!)).not.toBeNull();
    expect(Object.keys(await getCatalogHashes(worker.db!)).length).toBeGreaterThan(5);
  });

  it("une vente faite sur l'appareil relié arrive au Maître et le stock des deux baisse pareil", async () => {
    await saleOn(worker, variantA);
    expect(await stockOf(master, variantA, biz.locations.surface)).toBe(4);
    expect(await stockOf(worker, variantA, biz.locations.surface)).toBe(4);
    useDevice(master);
    expect((await master.db!.select().from(schema.sales)).length).toBe(1);
  });
});

describe("l'appareil relié suit le Maître après l'appairage", () => {
  it("un produit créé sur le Maître puis vendu sur le Maître : l'appareil relié reçoit tout, rien ne se perd", async () => {
    // Le Maître crée un produit, l'approvisionne et le vend AVANT que l'appareil relié ne sache rien du produit.
    const b = await act(master, () => createProduct(master.db!, { name: "Produit B", purchasePrice: 100, salePrice: 500, createdBy: biz.admin.id }, biz.admin.permissions));
    const variantB = b.defaultVariant.id;
    await act(master, () => addManualStockEntry(master.db!, { variantId: variantB, locationId: biz.locations.surface, quantity: 10, note: "arrivage", userId: biz.admin.id }, biz.admin.permissions));
    await saleOn(master, variantB);
    // Les événements sont arrivés à l'appareil relié sans leur catalogue : il l'a constaté (erreur vue), a
    // redemandé l'état au Maître tout seul, puis les a rejoués — rien n'est perdu.
    expect(applyErrorsSeen.some((e) => e.includes("introuvable"))).toBe(true);
    await syncWorker();
    expect(sync.hasFailedEvents()).toBe(false);
    expect(applyError).toBeNull();
    useDevice(worker);
    const products = await worker.db!.select().from(schema.products);
    expect(products.map((p) => p.name)).toContain("Produit B");
    expect(await stockOf(master, variantB, biz.locations.surface)).toBe(9);
    expect(await stockOf(worker, variantB, biz.locations.surface)).toBe(9);
    // L'appareil relié a bien reçu la vente du Maître (elle n'est pas « perdue »).
    expect((await worker.db!.select().from(schema.sales)).length).toBe(2);
    expect(await getLastAppliedSeq(worker.db!)).not.toBeNull();
  });

  it("un achat fait sur le Maître (non répliqué) fait quand même monter le stock de l'appareil relié", async () => {
    const supplier = await act(master, () => createSupplier(master.db!, { name: "Fournisseur", createdBy: biz.admin.id }, biz.admin.permissions));
    await act(master, () =>
      createPurchase(master.db!, { userId: biz.admin.id, supplierId: supplier.id, items: [{ variantId: variantA, quantity: 20, unitCost: 450 }], paymentMethod: "cash", storeId: biz.storeId }, biz.admin.permissions),
    );
    expect(await stockOf(master, variantA)).toBe(4 + 7 + 20);
    expect(await stockOf(worker, variantA)).toBe(4 + 7); // pas encore aligné
    await syncWorker();
    expect(await stockOf(worker, variantA)).toBe(4 + 7 + 20);
  });

  it("deux alignements de suite ne créent aucun mouvement de plus", async () => {
    useDevice(worker);
    const before = (await worker.db!.select().from(schema.stockMovements)).length;
    await syncWorker();
    await syncWorker();
    useDevice(worker);
    expect((await worker.db!.select().from(schema.stockMovements)).length).toBe(before);
  });

  it("un client créé sur le Maître arrive ; le client de passage créé sur l'appareil relié garde son identifiant local", async () => {
    // Deux clients créés sur le Maître que l'appareil relié ne connaît pas encore : leurs identifiants (1 et 2)
    // « entrent en collision » avec celui que l'appareil relié donne à son propre client de passage.
    await act(master, () => createCustomer(master.db!, { fullName: "Client Maître 1", createdBy: biz.admin.id }, biz.admin.permissions));
    await act(master, () => createCustomer(master.db!, { fullName: "Client Maître 2", createdBy: biz.admin.id }, biz.admin.permissions));
    // Client de passage saisi à la caisse de l'appareil relié (créé par la vente, avec son syncId).
    await saleOn(worker, variantA, { newCustomerName: "Passage Worker" });
    useDevice(worker);
    const localBefore = await worker.db!.select().from(schema.customers).where(eq(schema.customers.fullName, "Passage Worker")).get();
    expect(localBefore).toBeDefined();
    const saleBefore = (await worker.db!.select().from(schema.sales).where(eq(schema.sales.customerId, localBefore!.id)))[0];
    expect(saleBefore).toBeDefined();

    await act(master, () => createCustomer(master.db!, { fullName: "Client du Maître", phone: "0700000001", createdBy: biz.admin.id }, biz.admin.permissions));
    await syncWorker();

    useDevice(worker);
    const names = (await worker.db!.select().from(schema.customers)).map((c) => c.fullName);
    expect(names).toEqual(expect.arrayContaining(["Client du Maître", "Client Maître 1", "Client Maître 2"]));
    expect(names.filter((n) => n === "Passage Worker")).toHaveLength(1);
    const localAfter = await worker.db!.select().from(schema.customers).where(eq(schema.customers.fullName, "Passage Worker")).get();
    expect(localAfter!.id).toBe(localBefore!.id); // identifiant local inchangé : la vente y est toujours rattachée
    const saleAfter = await worker.db!.select().from(schema.sales).where(eq(schema.sales.id, saleBefore!.id)).get();
    expect(saleAfter!.customerId).toBe(localAfter!.id);
  });

  it("un prix changé sur le Maître arrive sur l'appareil relié", async () => {
    useDevice(master);
    await master.db!.update(schema.products).set({ salePrice: 1234 }).where(eq(schema.products.name, "Produit A")).run();
    await syncWorker();
    useDevice(worker);
    expect((await worker.db!.select().from(schema.products).where(eq(schema.products.name, "Produit A")).get())!.salePrice).toBe(1234);
  });

  it("un réglage propre à l'appareil (fréquence de sauvegarde) n'est pas écrasé par le Maître", async () => {
    useDevice(worker);
    await worker.db!.update(schema.businessSettings).set({ backupFrequency: "weekly" }).run();
    useDevice(master);
    await master.db!.update(schema.businessSettings).set({ businessName: "Nouvelle Enseigne", backupFrequency: "daily" }).run();
    await syncWorker();
    useDevice(worker);
    const settings = (await worker.db!.select().from(schema.businessSettings))[0]!;
    expect(settings.businessName).toBe("Nouvelle Enseigne");
    expect(settings.backupFrequency).toBe("weekly");
  });
});

describe("garde-fous de l'alignement du stock", () => {
  it("une vente créée sur l'appareil relié pendant l'alignement n'est pas effacée par un état périmé", async () => {
    useDevice(master);
    await master.db!.update(schema.products).set({ salePrice: 1500 }).where(eq(schema.products.name, "Produit A")).run();
    await protocol.checkCatalogChanged();
    toWorker.splice(0, toWorker.length); // l'avis n'est pas utile ici

    // L'appareil relié demande l'état...
    useDevice(worker);
    expect(await sync.requestRefresh()).toBe(true);
    await deliverToMaster(); // le Maître répond (réponse dans toWorker)
    expect(toWorker.some((m) => m.type === WsMessageTypes.snapshotResponse)).toBe(true);

    // ... et AVANT de la traiter, une vente est faite sur l'appareil relié.
    const stockBefore = await stockOf(worker, variantA);
    await act(worker, () =>
      createSale(worker.db!, { userId: biz.admin.id, saleMode: "pos", items: [{ variantId: variantA, quantity: 2, unitPrice: 1000 }], paymentMethod: "cash", surfaceLocationId: biz.locations.surface, storeId: biz.storeId }, biz.admin.permissions),
    );
    // Après la circulation complète : la vente est chez le Maître ET chez l'appareil relié, une seule fois.
    expect(await stockOf(worker, variantA)).toBe(stockBefore - 2);
    expect(await stockOf(master, variantA)).toBe(stockBefore - 2);
    await syncWorker();
    expect(await stockOf(worker, variantA)).toBe(await stockOf(master, variantA));
  });

  it("rien n'est en attente d'envoi à la fin", async () => {
    useDevice(worker);
    expect(await listPendingOutbox(worker.db!)).toHaveLength(0);
  });
});

describe("un événement impossible à appliquer ne fait pas avancer le repère en silence", () => {
  const forged = (kind: "loss" | "expense", n: number): SyncEvent => {
    if (kind === "loss") {
      return {
        eventId: `forged-${n}`,
        type: "stockLoss.created",
        createdAt: new Date().toISOString(),
        payload: { movement: { syncId: `mv-forged-${n}`, variantId: 99999, locationId: biz.locations.surface, batchSyncId: null, quantityDelta: -1, movementType: "loss", referenceType: "damage" } },
      };
    }
    return {
      eventId: `expense-${n}`,
      type: "expense.created",
      createdAt: new Date().toISOString(),
      payload: {
        expense: { syncId: `exp-${n}`, category: "Eau", amount: 100, expenseDate: "2026-10-31", note: null, paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId },
        payment: { syncId: `exp-pay-${n}`, method: "cash", amount: 100, storeId: biz.storeId, createdAt: "2026-10-31 12:00:00" },
      },
    };
  };

  it("le repère reste en arrière tant qu'un événement attend, puis avance quand il est abandonné (et c'est visible)", async () => {
    useDevice(worker);
    const base = (await getLastAppliedSeq(worker.db!))!;
    toMaster.length = 0;
    applyErrorsSeen.length = 0;

    sync.handleMessage(new WsMessage({ type: WsMessageTypes.sync, payload: { event: forged("loss", 1), seq: base + 1000 } }));
    sync.handleMessage(new WsMessage({ type: WsMessageTypes.sync, payload: { event: forged("expense", 2), seq: base + 1001 } }));
    await sync.idle();
    expect(sync.hasFailedEvents()).toBe(true);
    // L'événement suivant, lui, a bien été appliqué — mais le repère n'a pas bougé : au prochain démarrage le Maître renverra les deux.
    expect((await worker.db!.select().from(schema.expenses).where(eq(schema.expenses.syncId, "exp-2")).get())).toBeDefined();
    expect(await getLastAppliedSeq(worker.db!)).toBe(base);

    // Le catalogue du Maître n'y change rien : l'événement est abandonné, visiblement, et le repère rattrape son retard.
    await pump();
    expect(sync.hasFailedEvents()).toBe(false);
    expect(applyErrorsSeen.length).toBeGreaterThan(0);
    expect(applyError).not.toBeNull();
    expect(await getLastAppliedSeq(worker.db!)).toBe(base + 1001);
  });
});
