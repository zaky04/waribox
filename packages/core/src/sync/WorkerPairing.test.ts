import { schema } from "@gestion-boutique/database";
import { WsMessage, WsMessageTypes } from "@gestion-boutique/network";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "../auth/AuthService";
import { createProduct } from "../services/ProductsService";
import { createSale } from "../services/SalesService";
import { addManualStockEntry, getStockLevels } from "../services/StockService";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, useDevice, type TestDevice } from "../test/testDb";
import { createMasterProtocol, type MasterProtocol } from "./masterProtocol";
import type { SyncEvent } from "./syncEvents";
import { enqueueOutbox, getHelloSeq, getLastAppliedSeq, getPairedMasterId, listPendingOutbox, setLastAppliedSeq, setPairedMasterId } from "./syncStore";
import { createWorkerSync, type WorkerSync } from "./workerSync";

// Appairage : premier appairage d'un appareil qui avait un historique Solo, changement de Maître, Maître restauré.
// Deux vraies bases SQLite, le vrai protocole des deux côtés, un « réseau » en mémoire.

const CONN = "conn-p1";
let masterA: TestDevice;
let masterB: TestDevice;
let worker: TestDevice;
let bizA: SeededBusiness;
let bizSolo: SeededBusiness;
let protocol: MasterProtocol;
let sync: WorkerSync;
const toWorker: WsMessage[] = [];
const toMaster: WsMessage[] = [];
let currentMaster: TestDevice;
let applyError: string | null = null;
let variantA = 0;

async function pump() {
  for (let i = 0; i < 20 && (toMaster.length > 0 || toWorker.length > 0); i++) {
    while (toMaster.length > 0) {
      const m = toMaster.shift()!;
      useDevice(currentMaster);
      await protocol.handleMessage(CONN, m.encode());
      await protocol.idle();
    }
    while (toWorker.length > 0) {
      const m = toWorker.shift()!;
      useDevice(worker);
      if (m.type === WsMessageTypes.syncAck) await sync.noteAck(m.payload.seq);
      else sync.handleMessage(m);
      await sync.idle();
    }
  }
}

/** Connexion de l'appareil relié à un Maître, comme le fait l'application (numéro de progression propre à ce Maître). */
async function connectTo(id: string, device: TestDevice, extra: Record<string, unknown> = {}) {
  currentMaster = device;
  protocol = createMasterProtocol({ db: device.db!, masterId: id, masterName: id, send: (_c, m) => void toWorker.push(m) });
  useDevice(worker);
  const seq = await getHelloSeq(worker.db!, id);
  toMaster.push(new WsMessage({ type: WsMessageTypes.hello, payload: { deviceId: "tel-p", deviceName: "Tablette", ...(seq != null ? { lastSyncSeq: seq } : {}), ...extra } }));
  await pump();
}

const productNames = async (device: TestDevice) => {
  useDevice(device);
  return (await device.db!.select().from(schema.products)).map((p) => p.name);
};
const userNames = async (device: TestDevice) => {
  useDevice(device);
  return (await device.db!.select().from(schema.users)).map((u) => u.username).sort();
};
const fakeEvent = (id: string) => ({ eventId: id, type: "expense.created", createdAt: new Date().toISOString(), payload: {} }) as unknown as SyncEvent;

beforeAll(async () => {
  masterA = await createDevice("masterA");
  bizA = await seedBusiness(masterA.db!);
  const p = await createProduct(masterA.db!, { name: "Produit du Maître", purchasePrice: 100, salePrice: 500, createdBy: bizA.admin.id }, bizA.admin.permissions);
  variantA = p.defaultVariant.id;
  await addManualStockEntry(masterA.db!, { variantId: variantA, locationId: bizA.locations.surface, quantity: 8, note: "départ", userId: bizA.admin.id }, bizA.admin.permissions);

  masterB = await createDevice("masterB");
  const bizB = await seedBusiness(masterB.db!);
  await createProduct(masterB.db!, { name: "Produit de B", purchasePrice: 1, salePrice: 2, createdBy: bizB.admin.id }, bizB.admin.permissions);

  // L'appareil a un HISTORIQUE SOLO : un vendeur de plus que le Maître, deux produits, une vente de ce vendeur.
  worker = await createDevice("worker");
  bizSolo = await seedBusiness(worker.db!);
  const vendeur = await createUser(
    worker.db!,
    { fullName: "Vendeur Solo", username: "vsolo", password: "motdepasse-solo", pin: "864209", approvalPin: "310927", roleId: bizSolo.roles.caissier, storeId: bizSolo.storeId },
    bizSolo.admin.permissions,
  );
  const a = await createProduct(worker.db!, { name: "Ancien A", purchasePrice: 100, salePrice: 500, createdBy: bizSolo.admin.id }, bizSolo.admin.permissions);
  const b = await createProduct(worker.db!, { name: "Ancien B", purchasePrice: 100, salePrice: 700, createdBy: bizSolo.admin.id }, bizSolo.admin.permissions);
  for (const x of [a, b]) {
    await addManualStockEntry(worker.db!, { variantId: x.defaultVariant.id, locationId: bizSolo.locations.surface, quantity: 5, note: "x", userId: bizSolo.admin.id }, bizSolo.admin.permissions);
  }
  await createSale(
    worker.db!,
    { userId: vendeur.id, saleMode: "pos", items: [{ variantId: b.defaultVariant.id, quantity: 1, unitPrice: 700 }], paymentMethod: "cash", surfaceLocationId: bizSolo.locations.surface, storeId: bizSolo.storeId },
    bizSolo.admin.permissions,
  );
  // Un réglage propre à l'appareil, qui doit survivre.
  await worker.db!.update(schema.businessSettings).set({ backupFrequency: "weekly" }).run();

  sync = createWorkerSync({
    db: worker.db!,
    send: (m) => {
      toMaster.push(m);
      return true;
    },
    onApplyError: (r) => {
      applyError = r;
    },
  });
});

afterAll(releaseDevices);

describe("premier appairage d'un appareil qui avait un historique Solo", () => {
  it("se relie sans erreur : les données du Maître remplacent celles de l'appareil", async () => {
    await connectTo("master-A", masterA);
    expect(applyError).toBeNull();
    expect(await productNames(worker)).toEqual(["Produit du Maître"]);
    expect(await userNames(worker)).toEqual(await userNames(masterA));
    useDevice(worker);
    expect(await worker.db!.select().from(schema.sales)).toEqual([]);
    const levels = await getStockLevels(worker.db!, bizA.storeId);
    expect(levels.filter((l) => l.variantId === variantA).reduce((n, l) => n + l.quantity, 0)).toBe(8);
    expect(await getPairedMasterId(worker.db!)).toBe("master-A");
    expect(await getLastAppliedSeq(worker.db!)).not.toBeNull();
  });

  it("le réglage propre à l'appareil survit à la remise à zéro", async () => {
    useDevice(worker);
    expect((await worker.db!.select().from(schema.businessSettings))[0]?.backupFrequency).toBe("weekly");
  });
});

describe("reconnexion au MÊME Maître", () => {
  it("garde la file d'envoi et ne remet rien à zéro", async () => {
    useDevice(worker);
    const id = await enqueueOutbox(worker.db!, fakeEvent("e0"));
    expect(await getHelloSeq(worker.db!, "master-A")).not.toBeNull();
    await connectTo("master-A", masterA);
    useDevice(worker);
    expect((await listPendingOutbox(worker.db!)).map((x) => x.id)).toContain(id);
  });
});

describe("changement de Maître", () => {
  it("un autre Maître : l'appareil se présente comme jamais synchronisé et repart de l'état de ce Maître", async () => {
    useDevice(worker);
    const pending = (await listPendingOutbox(worker.db!)).map((x) => x.id);
    expect(pending.length).toBeGreaterThan(0);
    expect(await getHelloSeq(worker.db!, "master-B")).toBeNull();
    expect(await getHelloSeq(worker.db!, "master-A")).not.toBeNull();

    await connectTo("master-B", masterB);

    expect(await productNames(worker)).toEqual(["Produit de B"]);
    expect(await getPairedMasterId(worker.db!)).toBe("master-B");
    useDevice(worker);
    expect(await listPendingOutbox(worker.db!)).toEqual([]); // périmés : destinés à l'autre Maître
    expect(applyError).toBeNull();
  });

  it("l'ancienne saisie manuelle (identité « manual ») est supposée être le même Maître", async () => {
    useDevice(worker);
    expect(await getHelloSeq(worker.db!, "manual")).toBe(await getLastAppliedSeq(worker.db!));
  });

  it("un appareil relié avant l'existence de l'identité adopte le Maître qui répond", async () => {
    const legacy = await createDevice("legacy");
    await setLastAppliedSeq(legacy.db!, 12);
    expect(await getPairedMasterId(legacy.db!)).toBeNull();
    expect(await getHelloSeq(legacy.db!, "master-Z")).toBe(12);
    expect(await getPairedMasterId(legacy.db!)).toBe("master-Z");
    expect(await getHelloSeq(legacy.db!, "master-Y")).toBeNull();
    useDevice(worker);
  });
});

describe("Maître restauré ou réinitialisé", () => {
  it("un numéro de progression supérieur à celui du Maître déclenche l'état complet ; les envois en attente sont gardés", async () => {
    useDevice(worker);
    const pendingId = await enqueueOutbox(worker.db!, fakeEvent("e2"));
    await setLastAppliedSeq(worker.db!, 500); // l'appareil croit connaître 500 événements de ce Maître
    await setPairedMasterId(worker.db!, "master-B");

    await connectTo("master-B", masterB);

    useDevice(worker);
    // Reçu l'état complet : la progression est celle du Maître restauré, pas 500.
    expect(await getLastAppliedSeq(worker.db!)).toBeLessThan(500);
    expect(await productNames(worker)).toEqual(["Produit de B"]);
    // Même Maître : l'envoi en attente est conservé.
    expect((await listPendingOutbox(worker.db!)).map((x) => x.id)).toContain(pendingId);
  });
});

describe("sonde d'identification", () => {
  it("reçoit helloAck seulement : pas d'état, pas d'inscription comme appareil relié", async () => {
    currentMaster = masterA;
    protocol = createMasterProtocol({ db: masterA.db!, masterId: "master-A", masterName: "A", send: (_c, m) => void toWorker.push(m) });
    toMaster.push(new WsMessage({ type: WsMessageTypes.hello, payload: { deviceId: "sonde", deviceName: "Sonde", probe: true } }));
    useDevice(masterA);
    const before = toWorker.length;
    await protocol.handleMessage(CONN, toMaster.shift()!.encode());
    await protocol.idle();
    const replies = toWorker.splice(before);
    expect(replies.map((m) => m.type)).toEqual([WsMessageTypes.helloAck]);
    expect(replies[0]!.payload.masterId).toBe("master-A");
    expect(protocol.getWorkers().length).toBe(0);
  });
});
