import { schema } from "@gestion-boutique/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAlertRequestUrl, checkAlertChannelUrl, isValidSummaryTime, meetsSeverity, shouldRenotify } from "../domain/alertChannel";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, useDevice, type TestDevice } from "../test/testDb";
import {
  collectAggregateAlerts,
  collectEventAlerts,
  countUnsentAlerts,
  enqueueAlert,
  eventAlertFromAudit,
  listRecentAlerts,
  listUnsentAlerts,
  markAlertFailed,
  markAlertSent,
  queueDailySummaryIfDue,
  retryFailedAlerts,
} from "./AlertService";
import { logAction } from "./AuditService";
import { getSettings, updateSettings } from "./SettingsService";

describe("canal d'envoi", () => {
  it("vérifie l'adresse : https obligatoire, {text} obligatoire", () => {
    expect(checkAlertChannelUrl("https://api.telegram.org/bot1:AB/sendMessage?chat_id=5&text={text}")).toBe("ok");
    expect(checkAlertChannelUrl("")).toBe("empty");
    expect(checkAlertChannelUrl(null)).toBe("empty");
    expect(checkAlertChannelUrl("http://exemple.com/?t={text}")).toBe("notHttps");
    expect(checkAlertChannelUrl("https://exemple.com/?t=")).toBe("noTextPlaceholder");
    expect(checkAlertChannelUrl("pas une adresse {text}")).toBe("invalid");
    expect(checkAlertChannelUrl("javascript:alert({text})")).toBe("notHttps");
  });

  it("encode le texte et le téléphone, tronque un texte trop long", () => {
    expect(buildAlertRequestUrl("https://x.test/?t={text}&p={phone}", "Remise de 1 000 F & plus", "+225 07 07")).toBe("https://x.test/?t=Remise%20de%201%20000%20F%20%26%20plus&p=%2B2250707");
    const long = buildAlertRequestUrl("https://x.test/?t={text}", "a".repeat(5000));
    expect(decodeURIComponent(long.split("t=")[1]!).length).toBeLessThanOrEqual(1200);
    expect(decodeURIComponent(long.split("t=")[1]!).endsWith("…")).toBe(true);
  });

  it("gravité minimale et heure du résumé", () => {
    expect(meetsSeverity("danger", "warning")).toBe(true);
    expect(meetsSeverity("warning", "danger")).toBe(false);
    expect(meetsSeverity("info", "info")).toBe(true);
    expect(isValidSummaryTime("20:00")).toBe(true);
    expect(isValidSummaryTime("7:00")).toBe(false);
    expect(isValidSummaryTime("24:00")).toBe(false);
    expect(isValidSummaryTime("20:60")).toBe(false);
    expect(isValidSummaryTime(null)).toBe(false);
  });

  it("renvoie une alerte seulement si elle s'aggrave ou persiste plus de 7 jours", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const prev = { value: 5, severity: "warning" as const, at: "2026-11-19T12:00:00Z" };
    expect(shouldRenotify(null, { value: 1, severity: "warning" }, now)).toBe(true);
    expect(shouldRenotify(prev, { value: 5, severity: "warning" }, now)).toBe(false);
    expect(shouldRenotify(prev, { value: 4, severity: "warning" }, now)).toBe(false);
    expect(shouldRenotify(prev, { value: 6, severity: "warning" }, now)).toBe(true);
    expect(shouldRenotify(prev, { value: -9, severity: "warning" }, now)).toBe(true); // un écart négatif plus fort
    expect(shouldRenotify(prev, { value: 5, severity: "danger" }, now)).toBe(true);
    expect(shouldRenotify({ ...prev, at: "2026-11-10T12:00:00Z" }, { value: 5, severity: "warning" }, now)).toBe(true);
    expect(shouldRenotify({ ...prev, at: "pas une date" }, { value: 5, severity: "warning" }, now)).toBe(true);
  });
});

describe("alertes issues du journal d'audit", () => {
  const names = new Map([[1, "Awa"], [2, "Moussa"]]);
  const row = (action: string, meta: object, userId = 1) => ({ id: 1, userId, action, metadata: JSON.stringify(meta) });

  it("remise hors promotion, avec ou sans approbateur", () => {
    const a = eventAlertFromAudit(row("create_sale", { number: "VTE-1", unauthorizedDiscount: 1500 }), names)!;
    expect(a.severity).toBe("warning");
    expect(a.text).toContain("1 500 XOF");
    expect(a.text).toContain("VTE-1");
    expect(a.text).toContain("Awa");
    const b = eventAlertFromAudit(row("create_sale", { number: "VTE-1", unauthorizedDiscount: 1500, discountApprovedBy: 2 }), names)!;
    expect(b.text).toContain("Moussa");
    expect(eventAlertFromAudit(row("create_sale", { number: "VTE-1" }), names)).toBeNull();
    expect(eventAlertFromAudit(row("create_sale", { number: "VTE-1", unauthorizedDiscount: 0 }), names)).toBeNull();
  });

  it("ticket annulé, remboursement, perte de stock", () => {
    expect(eventAlertFromAudit(row("cancel_service_order", { number: "TCK-1", total: 3000, reason: "erreur" }), names)!.text).toContain("TCK-1");
    expect(eventAlertFromAudit(row("create_refund", { saleNumber: "VTE-2", total: 800, reason: "défaut" }), names)!.text).toContain("VTE-2");
    expect(eventAlertFromAudit(row("stock_loss", { value: 4000, reason: "theft" }), names)!.severity).toBe("warning");
    expect(eventAlertFromAudit(row("stock_loss", { value: 0, reason: "theft" }), names)).toBeNull();
  });

  it("écart de caisse : grave seulement s'il est signalé ; une clôture normale ne dit rien", () => {
    const a = eventAlertFromAudit(row("close_cash_session", { closingAmount: 9000, expectedAmount: 10000, difference: -1000, alert: true }), names)!;
    expect(a.severity).toBe("danger");
    expect(a.text).toContain("-1 000 XOF");
    expect(eventAlertFromAudit(row("close_cash_session", { closingAmount: 10000, expectedAmount: 10000, difference: 0, alert: false }), names)).toBeNull();
  });

  it("un utilisateur inconnu ne casse rien, une action sans intérêt est ignorée", () => {
    expect(eventAlertFromAudit(row("create_refund", { total: 1 }, 99), names)!.text.length).toBeGreaterThan(0);
    expect(eventAlertFromAudit(row("login", {}), names)).toBeNull();
    expect(eventAlertFromAudit({ id: 1, userId: null, action: "create_refund", metadata: "pas du json" }, names)!.text.length).toBeGreaterThan(0);
  });
});

describe("file d'alertes (base réelle)", () => {
  let device: TestDevice;
  let biz: SeededBusiness;

  beforeAll(async () => {
    device = await createDevice("alerts");
    biz = await seedBusiness(device.db!);
  });
  afterAll(releaseDevices);

  const audit = (action: string, metadata: Record<string, unknown>) => logAction(device.db!, { userId: biz.cashier.id, action, entity: "x", entityId: 1, metadata });

  it("le premier passage n'envoie rien de l'historique, les suivants voient seulement le neuf", async () => {
    useDevice(device);
    await audit("cancel_service_order", { number: "TCK-OLD", total: 1, reason: "ancien" });
    expect(await collectEventAlerts(device.db!, { minSeverity: "warning", businessName: "Chez Awa" })).toBe(0);
    expect(await collectEventAlerts(device.db!, { minSeverity: "warning" })).toBe(0);

    await audit("cancel_service_order", { number: "TCK-NEW", total: 2500, reason: "erreur de saisie" });
    await audit("close_cash_session", { closingAmount: 1, expectedAmount: 5001, difference: -5000, alert: true });
    await audit("login", {});
    expect(await collectEventAlerts(device.db!, { minSeverity: "warning", businessName: "Chez Awa" })).toBe(2);
    expect(await collectEventAlerts(device.db!, { minSeverity: "warning" })).toBe(0); // déjà vu

    const unsent = await listUnsentAlerts(device.db!);
    expect(unsent.map((a) => a.severity)).toEqual(["warning", "danger"]);
    expect(unsent[0]!.text.startsWith("[Chez Awa] ")).toBe(true);
    expect(unsent[0]!.text).toContain("TCK-NEW");
    expect(unsent.some((a) => a.text.includes("TCK-OLD"))).toBe(false);
  });

  it("la gravité minimale filtre à l'entrée", async () => {
    useDevice(device);
    await audit("cancel_service_order", { number: "TCK-LOW", total: 1, reason: "x" });
    await audit("close_cash_session", { closingAmount: 1, expectedAmount: 9001, difference: -9000, alert: true });
    expect(await collectEventAlerts(device.db!, { minSeverity: "danger" })).toBe(1);
    expect((await listRecentAlerts(device.db!)).some((a) => a.text.includes("TCK-LOW"))).toBe(false);
  });

  it("envoyée, échec, abandon après 5 échecs, nouvelle tentative", async () => {
    useDevice(device);
    const first = (await listUnsentAlerts(device.db!))[0]!;
    await markAlertSent(device.db!, first.id, "whatsapp");
    expect((await listUnsentAlerts(device.db!)).some((a) => a.id === first.id)).toBe(false);
    const sent = (await listRecentAlerts(device.db!)).find((a) => a.id === first.id)!;
    expect(sent.sentAt).not.toBeNull();
    expect(sent.channel).toBe("whatsapp");

    const next = (await listUnsentAlerts(device.db!))[0]!;
    for (let i = 0; i < 5; i++) await markAlertFailed(device.db!, next.id, "réseau coupé");
    expect((await listUnsentAlerts(device.db!)).some((a) => a.id === next.id)).toBe(false); // abandonnée
    expect(await countUnsentAlerts(device.db!)).toBeGreaterThan(0); // mais toujours visible comme non envoyée
    await retryFailedAlerts(device.db!);
    expect((await listUnsentAlerts(device.db!)).some((a) => a.id === next.id)).toBe(true);
  });

  it("une même clé n'est mise en file qu'une fois", async () => {
    useDevice(device);
    expect(await enqueueAlert(device.db!, { key: "k1", severity: "info", text: "a" })).toBe(true);
    expect(await enqueueAlert(device.db!, { key: "k1", severity: "info", text: "b" })).toBe(false);
  });

  it("résumé du jour : pas avant l'heure, une seule fois par jour, jamais sans heure programmée", async () => {
    useDevice(device);
    const at = (hh: number, mm: number, day = 20) => new Date(2026, 10, day, hh, mm, 0);
    expect(await queueDailySummaryIfDue(device.db!, { now: at(19, 59), time: "20:00" })).toBe(false);
    expect(await queueDailySummaryIfDue(device.db!, { now: at(20, 5), time: null })).toBe(false);
    expect(await queueDailySummaryIfDue(device.db!, { now: at(20, 5), time: "pas une heure" })).toBe(false);
    expect(await queueDailySummaryIfDue(device.db!, { now: at(20, 5), time: "20:00", businessName: "Chez Awa" })).toBe(true);
    expect(await queueDailySummaryIfDue(device.db!, { now: at(21, 30), time: "20:00" })).toBe(false);
    expect(await queueDailySummaryIfDue(device.db!, { now: at(20, 1, 21), time: "20:00" })).toBe(true); // lendemain
    const summaries = (await listRecentAlerts(device.db!)).filter((a) => a.key.startsWith("summary:"));
    expect(summaries.map((s) => s.key).sort()).toEqual(["summary:2026-11-20", "summary:2026-11-21"]);
    expect(summaries[0]!.severity).toBe("info");
  });

  it("l'analyse globale ne tourne pas plus d'une fois toutes les 30 minutes et ne casse pas une base saine", async () => {
    useDevice(device);
    const th = { refund: 5, loss: 2, discount: 5, staleDays: 30, pendingHours: 48 };
    const now = new Date(2026, 10, 22, 10, 0, 0);
    await collectAggregateAlerts(device.db!, { minSeverity: "info", thresholds: th, now });
    const soon = new Date(now.getTime() + 10 * 60 * 1000);
    expect(await collectAggregateAlerts(device.db!, { minSeverity: "info", thresholds: th, now: soon })).toBe(0);
    await expect(collectAggregateAlerts(device.db!, { minSeverity: "info", thresholds: th, now: new Date(now.getTime() + 40 * 60 * 1000) })).resolves.toBeTypeOf("number");
  });

  it("réglages : adresse https exigée, heure valide, gravité connue ; l'adresse est vidée proprement", async () => {
    useDevice(device);
    const admin = biz.admin;
    await expect(updateSettings(device.db!, { alertChannelUrl: "http://x.test/?t={text}" }, admin.permissions)).rejects.toThrow();
    await expect(updateSettings(device.db!, { alertChannelUrl: "https://x.test/?t=" }, admin.permissions)).rejects.toThrow();
    await expect(updateSettings(device.db!, { dailySummaryTime: "8h" }, admin.permissions)).rejects.toThrow();
    await expect(updateSettings(device.db!, { alertMinSeverity: "grave" as never }, admin.permissions)).rejects.toThrow();
    await updateSettings(device.db!, { alertChannelUrl: " https://x.test/?t={text} ", dailySummaryTime: "20:30", alertMinSeverity: "danger" }, admin.permissions);
    const saved = await getSettings(device.db!);
    expect(saved.alertChannelUrl).toBe("https://x.test/?t={text}");
    expect(saved.dailySummaryTime).toBe("20:30");
    expect(saved.alertMinSeverity).toBe("danger");
    await updateSettings(device.db!, { alertChannelUrl: "", dailySummaryTime: "" }, admin.permissions);
    const cleared = await getSettings(device.db!);
    expect(cleared.alertChannelUrl).toBeNull();
    expect(cleared.dailySummaryTime).toBeNull();
    // Les deux tables d'alertes survivent à une remise à zéro des données métier (tables « __ »).
    expect(schema.alertOutbox).toBeDefined();
  });
});
