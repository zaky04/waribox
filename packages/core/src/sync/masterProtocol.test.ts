import { schema } from "@gestion-boutique/database";
import { WsMessage, WsMessageTypes } from "@gestion-boutique/network";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPin } from "../auth/AuthService";
import { REMOTE_PIN_HASH } from "../auth/pin";
import { computePinProof, issuePinChallenge, PIN_CHALLENGE_TTL_MS, pinDecisionContext, verifyPinProof } from "../auth/pinProof";
import { setRemotePinVerifier } from "../auth/remotePin";
import { createApprovalRequest, snapshotApprovalRequest } from "../services/ApprovalService";
import { createExpense } from "../services/ExpensesService";
import { getSettings } from "../services/SettingsService";
import { ADMIN_PIN, CASHIER_PIN, MANAGER_PIN, seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, useDevice, type TestDevice } from "../test/testDb";
import { applyRemoteSyncEvent } from "./applyRemoteEvents";
import { createMasterProtocol, type MasterProtocol } from "./masterProtocol";
import { applyCatalogSnapshot, type CatalogSnapshot } from "./snapshot";
import { buildSyncEvent, onSyncEvent, type SyncEvent } from "./syncEvents";
import { discardRejectedOutbox, enqueueOutbox, listPendingOutbox, listRejectedOutbox, markOutboxRejected, retryRejectedOutbox } from "./syncStore";
import { createWorkerRpc } from "./workerRpc";

// Test de bout en bout du protocole Maître ↔ appareil relié : DEUX vraies bases
// SQLite (le Maître et un appareil relié), le vrai protocole du Maître, le vrai
// client de requêtes de l'appareil, et des vraies opérations métier. Seul le
// transport (WebSocket + serveur Rust) est remplacé par des appels directs.

const CONN = "conn-1";

let master: TestDevice;
let worker: TestDevice;
let biz: SeededBusiness;
let protocol: MasterProtocol;
let toWorker: WsMessage[] = [];
let rpc: ReturnType<typeof createWorkerRpc>;

function asMaster() {
  return useDevice(master);
}

// Envoie une trame au Maître comme le ferait le serveur Rust, et attend la fin du traitement.
async function sendToMaster(message: WsMessage, connectionId = CONN): Promise<void> {
  asMaster();
  await protocol.handleMessage(connectionId, message.encode());
  await protocol.idle();
}

function lastReply(type: string): WsMessage | undefined {
  return [...toWorker].reverse().find((m) => m.type === type);
}

async function helloAsFreshWorker(): Promise<void> {
  toWorker = [];
  await sendToMaster(new WsMessage({ type: WsMessageTypes.hello, payload: { deviceId: "tel-1", deviceName: "Téléphone caisse" } }));
}

/** Capture les événements de synchronisation émis par une opération exécutée sur l'appareil relié. */
async function captureEvents(run: () => Promise<unknown>): Promise<SyncEvent[]> {
  const events: SyncEvent[] = [];
  const off = onSyncEvent((e) => events.push(e));
  try {
    await run();
  } finally {
    off();
  }
  return events;
}

beforeAll(async () => {
  master = await createDevice("master");
  biz = await seedBusiness(master.db!);
  await getSettings(master.db!);
  await master.db!.update(schema.businessSettings).set({ maintenanceCodeHash: "SECRET-MAINTENANCE-HASH" }).run();
  worker = await createDevice("worker");

  protocol = createMasterProtocol({
    db: master.db!,
    masterId: "master-1",
    masterName: "Caisse principale",
    send: (_id, message) => {
      toWorker.push(message);
      rpc?.handle(message);
    },
  });
  rpc = createWorkerRpc({
    send: (message) => {
      void sendToMaster(message);
      return true;
    },
    timeoutMs: 10_000,
  });

  await helloAsFreshWorker();
  const snapshot = lastReply(WsMessageTypes.snapshotResponse)!.payload.snapshot as CatalogSnapshot;
  useDevice(worker);
  await applyCatalogSnapshot(worker.db!, snapshot);
});

afterAll(() => {
  setRemotePinVerifier(null);
  releaseDevices();
});

describe("poignée de main et instantané", () => {
  it("accepte le hello, renvoie l'instantané et connaît l'appareil", () => {
    expect(lastReply(WsMessageTypes.helloAck)!.payload.accepted).toBe(true);
    expect(lastReply(WsMessageTypes.snapshotResponse)).toBeDefined();
    expect(protocol.getWorkers().map((w) => w.deviceId)).toEqual(["tel-1"]);
  });

  it("l'instantané ne contient AUCUN hash de PIN ni code de maintenance", async () => {
    const snapshot = lastReply(WsMessageTypes.snapshotResponse)!.payload.snapshot as CatalogSnapshot;
    expect(snapshot.users.length).toBeGreaterThanOrEqual(3);
    for (const u of snapshot.users) expect(u.pinHash === null || u.pinHash === REMOTE_PIN_HASH).toBe(true);
    // Aucun des vrais hash de PIN du Maître n'apparaît nulle part dans ce qui part sur le réseau.
    const serialized = JSON.stringify(snapshot);
    const realPinHashes = (await asMaster().select({ pinHash: schema.users.pinHash }).from(schema.users)).map((r) => r.pinHash!);
    expect(realPinHashes.length).toBeGreaterThanOrEqual(3);
    for (const hash of realPinHashes) expect(serialized).not.toContain(hash);
    expect(snapshot.users.every((u) => u.passwordHash === null || u.passwordHash.startsWith("$argon2id$"))).toBe(true);
    expect(snapshot.users.filter((u) => u.pinHash).length).toBe(3);
    expect(snapshot.businessSettings).toBeDefined();
    expect(snapshot.businessSettings).not.toHaveProperty("maintenanceCodeHash");
    expect(serialized).not.toContain("SECRET-MAINTENANCE-HASH");
  });

  it("la base de l'appareil relié ne contient aucun hash de PIN exploitable", async () => {
    useDevice(worker);
    const rows = await worker.db!.select({ pinHash: schema.users.pinHash }).from(schema.users);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) expect(r.pinHash === null || r.pinHash === REMOTE_PIN_HASH).toBe(true);
    // Le mot de passe reste vérifiable hors ligne (le gérant se connecte avec son compte).
    const withPassword = await worker.db!.select({ passwordHash: schema.users.passwordHash }).from(schema.users);
    expect(withPassword.every((r) => !!r.passwordHash)).toBe(true);
  });

  it("ignore tout message envoyé avant le hello", async () => {
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.snapshotRequest }), "inconnue");
    await sendToMaster(new WsMessage({ type: WsMessageTypes.pinChallenge, payload: { approverId: biz.admin.id } }), "inconnue");
    expect(toWorker).toHaveLength(0);
  });

  it("répond à ping par pong", async () => {
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.ping }), "inconnue");
    expect(toWorker.map((m) => m.type)).toEqual([WsMessageTypes.pong]);
  });
});

describe("synchronisation : un refus est toujours signalé", () => {
  it("un événement de dépense valide est appliqué, consigné et acquitté", async () => {
    useDevice(worker);
    const events = await captureEvents(() =>
      createExpense(worker.db!, { category: "Transport", amount: 1500, expenseDate: "2026-10-25", paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions),
    );
    expect(events.map((e) => e.type)).toContain("expense.created");
    toWorker = [];
    const msg = new WsMessage({ type: WsMessageTypes.sync, payload: { event: events[0] } });
    await sendToMaster(msg);
    expect(lastReply(WsMessageTypes.syncAck)?.correlationId).toBe(msg.correlationId);
    expect(lastReply(WsMessageTypes.syncRejected)).toBeUndefined();
    asMaster();
    const expenses = await master.db!.select().from(schema.expenses);
    expect(expenses.filter((e) => e.category === "Transport")).toHaveLength(1);
    const log = await master.db!.select().from(schema.syncLog);
    expect(log.some((l) => l.eventType === "expense.created" && l.originDeviceId === "tel-1")).toBe(true);
  });

  it("renvoyer le même événement (ack perdu) ne crée pas de doublon", async () => {
    useDevice(worker);
    const events = await captureEvents(() =>
      createExpense(worker.db!, { category: "Eau", amount: 800, expenseDate: "2026-10-25", paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions),
    );
    const msg = new WsMessage({ type: WsMessageTypes.sync, payload: { event: events[0] } });
    await sendToMaster(msg);
    await sendToMaster(new WsMessage({ type: WsMessageTypes.sync, payload: { event: events[0] } }));
    asMaster();
    expect((await master.db!.select().from(schema.expenses)).filter((e) => e.category === "Eau")).toHaveLength(1);
  });

  it("un événement forgé (type inconnu) est refusé avec une raison, rien n'est consigné", async () => {
    asMaster();
    const before = (await master.db!.select().from(schema.syncLog)).length;
    toWorker = [];
    const msg = new WsMessage({ type: WsMessageTypes.sync, payload: { event: { eventId: "x", type: "sale.deleted", createdAt: "2026-10-25", payload: {} } } });
    await sendToMaster(msg);
    const rejected = lastReply(WsMessageTypes.syncRejected);
    expect(rejected?.correlationId).toBe(msg.correlationId);
    expect(String(rejected?.payload.reason)).not.toBe("");
    expect(lastReply(WsMessageTypes.syncAck)).toBeUndefined();
    asMaster();
    expect((await master.db!.select().from(schema.syncLog)).length).toBe(before);
  });

  it("une charge utile sans objet est refusée", async () => {
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.sync, payload: { event: "n'importe quoi" } }));
    await sendToMaster(new WsMessage({ type: WsMessageTypes.sync, payload: {} }));
    expect(toWorker.filter((m) => m.type === WsMessageTypes.syncRejected)).toHaveLength(2);
  });

  it("un événement qui échoue à la validation est refusé ET annulé entièrement", async () => {
    useDevice(worker);
    const [event] = await captureEvents(() =>
      createExpense(worker.db!, { category: "Forgée", amount: 100, expenseDate: "2026-10-25", paymentMethod: "cash", userId: 9999, storeId: biz.storeId }, biz.admin.permissions).catch(() => undefined),
    );
    // Si l'opération locale échoue (utilisateur inconnu) il n'y a pas d'événement : on en fabrique un à la main.
    const forged = event ?? buildSyncEvent("stockLoss.created", { movement: { quantityDelta: 5 } } as never);
    toWorker = [];
    const msg = new WsMessage({ type: WsMessageTypes.sync, payload: { event: forged } });
    await sendToMaster(msg);
    expect(lastReply(WsMessageTypes.syncRejected)?.correlationId).toBe(msg.correlationId);
    asMaster();
    expect((await master.db!.select().from(schema.expenses)).filter((e) => e.category === "Forgée")).toHaveLength(0);
    const audit = await master.db!.select().from(schema.auditLog);
    expect(audit.some((a) => a.action === "sync_event_rejected")).toBe(true);
  });

  it("applique les événements dans l'ordre d'arrivée même envoyés d'un coup", async () => {
    useDevice(worker);
    const evs: SyncEvent[] = [];
    for (const category of ["Ordre-1", "Ordre-2", "Ordre-3"]) {
      evs.push(
        ...(await captureEvents(() =>
          createExpense(worker.db!, { category, amount: 100, expenseDate: "2026-10-25", paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions),
        )),
      );
    }
    asMaster();
    const before = (await master.db!.select().from(schema.syncLog)).length;
    await Promise.all(evs.map((event) => protocol.handleMessage(CONN, new WsMessage({ type: WsMessageTypes.sync, payload: { event } }).encode())));
    await protocol.idle();
    const log = (await master.db!.select().from(schema.syncLog)).slice(before);
    expect(log).toHaveLength(3);
    const order = log.map((l) => (JSON.parse(l.payloadJson) as SyncEvent).eventId);
    expect(order).toEqual(evs.map((e) => e.eventId));
  });

  it("rediffuse aux AUTRES appareils reliés, pas à l'émetteur", async () => {
    toWorker = [];
    const otherInbox: WsMessage[] = [];
    const p2 = createMasterProtocol({
      db: master.db!,
      masterId: "master-1",
      masterName: "Caisse principale",
      send: (id, m) => {
        (id === "conn-2" ? otherInbox : toWorker).push(m);
      },
    });
    asMaster();
    await p2.handleMessage("conn-1", new WsMessage({ type: WsMessageTypes.hello, payload: { deviceId: "tel-1", deviceName: "A", lastSyncSeq: 999999 } }).encode());
    await p2.handleMessage("conn-2", new WsMessage({ type: WsMessageTypes.hello, payload: { deviceId: "tel-2", deviceName: "B", lastSyncSeq: 999999 } }).encode());
    await p2.idle();
    useDevice(worker);
    const [event] = await captureEvents(() =>
      createExpense(worker.db!, { category: "Diffusée", amount: 100, expenseDate: "2026-10-25", paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions),
    );
    toWorker = [];
    asMaster();
    await p2.handleMessage("conn-1", new WsMessage({ type: WsMessageTypes.sync, payload: { event } }).encode());
    await p2.idle();
    expect(otherInbox.filter((m) => m.type === WsMessageTypes.sync)).toHaveLength(1);
    expect(toWorker.filter((m) => m.type === WsMessageTypes.sync)).toHaveLength(0);
    expect(toWorker.filter((m) => m.type === WsMessageTypes.syncAck)).toHaveLength(1);
  });
});

describe("décisions d'approbation : le décideur est authentifié", () => {
  async function newExpenseRequest(requestedBy: number, amount = 5000, category = "Loyer") {
    asMaster();
    return createApprovalRequest(master.db!, {
      kind: "expense",
      amount,
      requestedBy,
      storeId: biz.storeId,
      summary: `Dépense ${category}`,
      payload: { input: { category, amount, expenseDate: "2026-10-25", paymentMethod: "cash", userId: requestedBy, storeId: biz.storeId } },
    });
  }
  const requestRow = async (id: number) => (await asMaster().select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, id)).get())!;
  const failedAttempts = async (id: number) => (await asMaster().select().from(schema.users).where(eq(schema.users.id, id)).get())!.failedAttempts;

  it("un événement « décidé » envoyé par un appareil relié est REFUSÉ (le décideur serait déclaratif)", async () => {
    const request = await newExpenseRequest(biz.cashier.id);
    const forged = buildSyncEvent("approvalRequest.decided", {
      request: snapshotApprovalRequest(request),
      approve: true,
      decidedBy: biz.admin.id, // se fait passer pour l'administrateur
      note: null,
      decidedAt: "2026-10-25 10:00:00",
    });
    toWorker = [];
    const msg = new WsMessage({ type: WsMessageTypes.sync, payload: { event: forged } });
    await sendToMaster(msg);
    expect(lastReply(WsMessageTypes.syncRejected)?.correlationId).toBe(msg.correlationId);
    expect((await requestRow(request.id)).status).toBe("pending");
    asMaster();
    expect((await master.db!.select().from(schema.expenses)).filter((e) => e.category === "Loyer")).toHaveLength(0);
  });

  it("côté Maître seulement : le même événement venant du Maître lui-même reste applicable", async () => {
    // Un appareil relié applique ce que le Maître lui diffuse (origine « master »).
    useDevice(worker);
    const request = {
      syncId: "00000000-0000-4000-8000-000000000001",
      kind: "expense",
      amount: 10,
      requestedBy: biz.cashier.id,
      storeId: biz.storeId,
      summary: "x",
      payload: JSON.stringify({ input: { category: "Papeterie", amount: 10, expenseDate: "2026-10-25", userId: biz.cashier.id, storeId: biz.storeId } }),
      createdAt: "2026-10-25 09:00:00",
    };
    const decided = buildSyncEvent("approvalRequest.decided", { request, approve: false, decidedBy: biz.admin.id, note: "non", decidedAt: "2026-10-25 10:00:00" });
    await applyRemoteSyncEvent(worker.db!, decided); // origine par défaut = master
    const row = await worker.db!.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.syncId, request.syncId)).get();
    expect(row?.status).toBe("rejected");
    await expect(applyRemoteSyncEvent(worker.db!, decided, "worker")).rejects.toThrow();
  });

  it("décision à distance avec le bon PIN : approuvée, dépense créée une seule fois, rediffusée", async () => {
    const request = await newExpenseRequest(biz.cashier.id, 7000, "Loyer-OK");
    toWorker = [];
    await rpc.decide({ requestSyncId: request.syncId!, approverId: biz.admin.id, pin: ADMIN_PIN, approve: true });
    await protocol.idle();
    const row = await requestRow(request.id);
    expect(row.status).toBe("approved");
    expect(row.decidedBy).toBe(biz.admin.id);
    asMaster();
    expect((await master.db!.select().from(schema.expenses)).filter((e) => e.category === "Loyer-OK")).toHaveLength(1);
    // L'événement « décidé » est émis par le Maître lui-même et rediffusé aux appareils (via le bus local).
    expect(await failedAttempts(biz.admin.id)).toBe(0);
  });

  it("mauvais PIN : refusé, demande intacte, essai compté", async () => {
    const request = await newExpenseRequest(biz.cashier.id, 3000, "Loyer-KO");
    const before = await failedAttempts(biz.admin.id);
    await expect(rpc.decide({ requestSyncId: request.syncId!, approverId: biz.admin.id, pin: "000000", approve: true })).rejects.toThrow();
    expect((await requestRow(request.id)).status).toBe("pending");
    expect(await failedAttempts(biz.admin.id)).toBe(before + 1);
    // Le bon PIN passe toujours ensuite.
    await rpc.decide({ requestSyncId: request.syncId!, approverId: biz.admin.id, pin: ADMIN_PIN, approve: false, note: "refusé" });
    expect((await requestRow(request.id)).status).toBe("rejected");
  });

  it("le défi est à usage unique : rejouer la même preuve échoue", async () => {
    const request = await newExpenseRequest(biz.cashier.id, 2000, "Rejeu");
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.pinChallenge, payload: { approverId: biz.admin.id } }));
    const challenge = lastReply(WsMessageTypes.pinChallengeResult)!.payload.challenge as Parameters<typeof computePinProof>[1];
    const proof = await computePinProof(ADMIN_PIN, challenge, pinDecisionContext(request.syncId!, true));
    const decision = { requestSyncId: request.syncId, approverId: biz.admin.id, approve: true, nonce: challenge.nonce, proof };
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.approvalDecision, payload: decision }));
    expect(lastReply(WsMessageTypes.approvalDecisionResult)?.payload.ok).toBe(true);
    // Une autre demande, MÊME preuve : refusée (nonce consommé, et contexte différent).
    const other = await newExpenseRequest(biz.cashier.id, 2100, "Rejeu-2");
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.approvalDecision, payload: { ...decision, requestSyncId: other.syncId } }));
    expect(lastReply(WsMessageTypes.approvalDecisionResult)?.payload.ok).toBe(false);
    expect((await requestRow(other.id)).status).toBe("pending");
  });

  it("une preuve pour « approuver » ne sert pas à « refuser » (et inversement)", async () => {
    const request = await newExpenseRequest(biz.cashier.id, 2200, "Contexte");
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.pinChallenge, payload: { approverId: biz.admin.id } }));
    const challenge = lastReply(WsMessageTypes.pinChallengeResult)!.payload.challenge as Parameters<typeof computePinProof>[1];
    const proofForApprove = await computePinProof(ADMIN_PIN, challenge, pinDecisionContext(request.syncId!, true));
    toWorker = [];
    await sendToMaster(
      new WsMessage({
        type: WsMessageTypes.approvalDecision,
        payload: { requestSyncId: request.syncId, approverId: biz.admin.id, approve: false, note: "x", nonce: challenge.nonce, proof: proofForApprove },
      }),
    );
    expect(lastReply(WsMessageTypes.approvalDecisionResult)?.payload.ok).toBe(false);
    expect((await requestRow(request.id)).status).toBe("pending");
  });

  it("une preuve « vérification de PIN » ne peut pas trancher une demande", async () => {
    const request = await newExpenseRequest(biz.cashier.id, 2300, "Contexte-2");
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.pinChallenge, payload: { approverId: biz.admin.id } }));
    const challenge = lastReply(WsMessageTypes.pinChallengeResult)!.payload.challenge as Parameters<typeof computePinProof>[1];
    const proofForVerify = await computePinProof(ADMIN_PIN, challenge, "verify");
    toWorker = [];
    await sendToMaster(
      new WsMessage({
        type: WsMessageTypes.approvalDecision,
        payload: { requestSyncId: request.syncId, approverId: biz.admin.id, approve: true, nonce: challenge.nonce, proof: proofForVerify },
      }),
    );
    expect(lastReply(WsMessageTypes.approvalDecisionResult)?.payload.ok).toBe(false);
    expect((await requestRow(request.id)).status).toBe("pending");
  });

  it("la MÊME preuve rejouée à l'identique (même défi, même contexte) est refusée la seconde fois", async () => {
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.pinChallenge, payload: { approverId: biz.admin.id } }));
    const challenge = lastReply(WsMessageTypes.pinChallengeResult)!.payload.challenge as Parameters<typeof computePinProof>[1];
    const proof = await computePinProof(ADMIN_PIN, challenge, "verify");
    const verify = new WsMessage({ type: WsMessageTypes.pinVerify, payload: { approverId: biz.admin.id, nonce: challenge.nonce, proof } });
    toWorker = [];
    await sendToMaster(verify);
    expect(lastReply(WsMessageTypes.pinVerifyResult)?.payload.ok).toBe(true);
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.pinVerify, payload: { approverId: biz.admin.id, nonce: challenge.nonce, proof } }));
    expect(lastReply(WsMessageTypes.pinVerifyResult)?.payload.ok).toBe(false);
  });

  it("un défi expire au bout de 60 secondes", async () => {
    asMaster();
    const t0 = Date.now();
    const challenge = await issuePinChallenge(master.db!, biz.admin.id, t0);
    const proof = await computePinProof(ADMIN_PIN, challenge, "verify");
    expect(await verifyPinProof(master.db!, biz.admin.id, challenge.nonce, "verify", proof, t0 + PIN_CHALLENGE_TTL_MS + 1)).toBe(false);
    const fresh = await issuePinChallenge(master.db!, biz.admin.id, t0);
    const freshProof = await computePinProof(ADMIN_PIN, fresh, "verify");
    expect(await verifyPinProof(master.db!, biz.admin.id, fresh.nonce, "verify", freshProof, t0 + 5_000)).toBe(true);
  });

  it("un défi demandé pour un responsable ne sert pas pour un autre", async () => {
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.pinChallenge, payload: { approverId: biz.manager.id } }));
    const challenge = lastReply(WsMessageTypes.pinChallengeResult)!.payload.challenge as Parameters<typeof computePinProof>[1];
    const proof = await computePinProof(MANAGER_PIN, challenge, "verify");
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.pinVerify, payload: { approverId: biz.admin.id, nonce: challenge.nonce, proof } }));
    expect(lastReply(WsMessageTypes.pinVerifyResult)?.payload.ok).toBe(false);
  });

  it("un utilisateur sans droit d'approbation (caissier) ne peut pas trancher, même avec son vrai PIN", async () => {
    const request = await newExpenseRequest(biz.manager.id, 2400, "Sans-droit");
    await expect(rpc.decide({ requestSyncId: request.syncId!, approverId: biz.cashier.id, pin: CASHIER_PIN, approve: true })).rejects.toThrow();
    expect((await requestRow(request.id)).status).toBe("pending");
  });

  it("on ne peut pas trancher sa propre demande, même avec son vrai PIN", async () => {
    const request = await newExpenseRequest(biz.admin.id, 2500, "Soi-même");
    await expect(rpc.decide({ requestSyncId: request.syncId!, approverId: biz.admin.id, pin: ADMIN_PIN, approve: true })).rejects.toThrow();
    expect((await requestRow(request.id)).status).toBe("pending");
  });

  it("le plafond d'approbation personnel est respecté à distance", async () => {
    asMaster();
    await master.db!.update(schema.users).set({ limitApprove: 1000 }).where(eq(schema.users.id, biz.admin.id)).run();
    const request = await newExpenseRequest(biz.cashier.id, 5000, "Plafond");
    await expect(rpc.decide({ requestSyncId: request.syncId!, approverId: biz.admin.id, pin: ADMIN_PIN, approve: true })).rejects.toThrow();
    expect((await requestRow(request.id)).status).toBe("pending");
    asMaster();
    await master.db!.update(schema.users).set({ limitApprove: null }).where(eq(schema.users.id, biz.admin.id)).run();
  });

  it("un responsable verrouillé (trop d'essais) ne reçoit plus de défi", async () => {
    asMaster();
    await master.db!.update(schema.users).set({ lockedUntil: new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19) }).where(eq(schema.users.id, biz.manager.id)).run();
    toWorker = [];
    await sendToMaster(new WsMessage({ type: WsMessageTypes.pinChallenge, payload: { approverId: biz.manager.id } }));
    expect(lastReply(WsMessageTypes.pinChallengeResult)?.payload.ok).toBe(false);
    asMaster();
    await master.db!.update(schema.users).set({ lockedUntil: null, failedAttempts: 0 }).where(eq(schema.users.id, biz.manager.id)).run();
  });

  it("une demande inconnue est refusée proprement", async () => {
    await expect(rpc.decide({ requestSyncId: "inconnue", approverId: biz.admin.id, pin: ADMIN_PIN, approve: true })).rejects.toThrow();
  });
});

describe("PIN vérifié à distance (approbation immédiate sur l'appareil relié)", () => {
  it("l'appareil relié vérifie le PIN du propriétaire via le Maître, sans jamais en détenir le hash", async () => {
    useDevice(worker);
    setRemotePinVerifier(rpc.verifyPin);
    // Pendant que la base active est celle de l'appareil relié, le Maître répond avec la sienne :
    // sendToMaster rebascule sur le Maître le temps du traitement.
    const ok = await verifyPin(worker.db!, biz.admin.id, ADMIN_PIN);
    expect(ok).toBe(true);
    useDevice(worker);
    expect(await verifyPin(worker.db!, biz.admin.id, "999999")).toBe(false);
    setRemotePinVerifier(null);
  });

  it("hors connexion (aucun vérificateur) l'approbation par PIN est impossible, avec un message explicite", async () => {
    useDevice(worker);
    setRemotePinVerifier(null);
    await expect(verifyPin(worker.db!, biz.admin.id, ADMIN_PIN)).rejects.toThrow();
  });

  it("connexion coupée pendant la vérification : la requête échoue tout de suite", async () => {
    const dead = createWorkerRpc({ send: () => false });
    await expect(dead.verifyPin(biz.admin.id, ADMIN_PIN)).rejects.toThrow();
    const hanging = createWorkerRpc({ send: () => true, timeoutMs: 5000 });
    const pending = hanging.verifyPin(biz.admin.id, ADMIN_PIN);
    hanging.rejectAll("coupée");
    await expect(pending).rejects.toThrow("coupée");
  });
});

describe("file d'attente de l'appareil relié : un refus ne boucle pas", () => {
  it("un événement refusé sort de la file automatique, reste visible, peut être réessayé ou abandonné", async () => {
    useDevice(worker);
    const [event] = await captureEvents(() =>
      createExpense(worker.db!, { category: "File", amount: 100, expenseDate: "2026-10-25", paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions),
    );
    const id = await enqueueOutbox(worker.db!, event!);
    expect((await listPendingOutbox(worker.db!)).map((p) => p.id)).toContain(id);

    await markOutboxRejected(worker.db!, id, "stock insuffisant");
    expect((await listPendingOutbox(worker.db!)).map((p) => p.id)).not.toContain(id);
    const rejected = await listRejectedOutbox(worker.db!);
    expect(rejected.find((r) => r.id === id)?.reason).toBe("stock insuffisant");

    await retryRejectedOutbox(worker.db!, id);
    expect((await listPendingOutbox(worker.db!)).map((p) => p.id)).toContain(id);
    expect(await listRejectedOutbox(worker.db!)).toHaveLength(0);

    await markOutboxRejected(worker.db!, id, "encore");
    await discardRejectedOutbox(worker.db!, id);
    expect(await listRejectedOutbox(worker.db!)).toHaveLength(0);
    expect((await listPendingOutbox(worker.db!)).map((p) => p.id)).not.toContain(id);
  });

  it("abandonner ne supprime jamais un événement encore en attente d'envoi", async () => {
    useDevice(worker);
    const [event] = await captureEvents(() =>
      createExpense(worker.db!, { category: "File-2", amount: 100, expenseDate: "2026-10-25", paymentMethod: "cash", userId: biz.admin.id, storeId: biz.storeId }, biz.admin.permissions),
    );
    const id = await enqueueOutbox(worker.db!, event!);
    await discardRejectedOutbox(worker.db!, id);
    expect((await listPendingOutbox(worker.db!)).map((p) => p.id)).toContain(id);
  });
});
