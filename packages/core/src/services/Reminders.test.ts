import { schema } from "@gestion-boutique/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, useDevice, type TestDevice } from "../test/testDb";
import { listRecentAlerts } from "./AlertService";
import { buildReminderText, listDueReminders, nextReminderStep, queueReminderDigest, recordReminderSent, reminderTone } from "./ReminderService";

describe("calendrier des relances", () => {
  it("rien avant le premier retard, puis une étape par palier", () => {
    expect(nextReminderStep(0, [])).toBeNull();
    expect(nextReminderStep(-3, [])).toBeNull();
    expect(nextReminderStep(1, [])).toBe(1);
    expect(nextReminderStep(6, [1])).toBeNull();
    expect(nextReminderStep(7, [1])).toBe(7);
    expect(nextReminderStep(15, [1, 7])).toBe(15);
    expect(nextReminderStep(40, [1, 7, 15])).toBe(30);
    expect(nextReminderStep(90, [1, 7, 15, 30])).toBeNull();
  });

  it("des étapes manquées : seule la plus avancée compte ; une étape plus basse qu'une envoyée est dépassée", () => {
    expect(nextReminderStep(20, [])).toBe(15);
    expect(nextReminderStep(8, [7])).toBeNull();
    expect(nextReminderStep(8, [15])).toBeNull();
  });

  it("le ton monte avec le retard", () => {
    expect(reminderTone(1)).toBe("gentle");
    expect(reminderTone(7)).toBe("firm");
    expect(reminderTone(15)).toBe("firm");
    expect(reminderTone(30)).toBe("final");
  });
});

describe("relances (base réelle)", () => {
  let device: TestDevice;
  let biz: SeededBusiness;
  const credit = async (customerId: number, remaining: number, dueDate: string | null, status = "open") =>
    (await device.db!.insert(schema.customerCredits).values({ customerId, originalAmount: remaining, remainingBalance: remaining, dueDate, status }).returning().get()).id;

  beforeAll(async () => {
    device = await createDevice("reminders");
    biz = await seedBusiness(device.db!);
  });
  afterAll(releaseDevices);

  it("liste les relances dues, au bon ton, et les note", async () => {
    useDevice(device);
    const awa = await device.db!.insert(schema.customers).values({ fullName: "Awa Koné", phone: "0707070707" }).returning().get();
    const sans = await device.db!.insert(schema.customers).values({ fullName: "Sans Téléphone" }).returning().get();
    const now = new Date(2026, 10, 20, 10, 0, 0);
    const late8 = await credit(awa.id, 5000, "2026-11-12"); // 8 jours de retard → étape 7
    const late40 = await credit(sans.id, 12000, "2026-10-11"); // 40 jours → étape 30
    await credit(awa.id, 900, "2026-11-25"); // pas encore échue
    await credit(awa.id, 700, "2026-10-01", "settled"); // soldée
    await credit(awa.id, 0, "2026-10-01"); // rien à payer

    const due = await listDueReminders(device.db!, now);
    expect(due.map((d) => d.creditId)).toEqual([late40, late8]); // plus en retard d'abord
    expect(due[0]).toMatchObject({ customerName: "Sans Téléphone", phone: null, step: 30, tone: "final", daysLate: 40 });
    expect(due[1]).toMatchObject({ customerName: "Awa Koné", phone: "0707070707", step: 7, tone: "firm", daysLate: 8, amount: 5000 });

    const text = buildReminderText(due[1]!, "Chez Awa");
    expect(text).toContain("Awa Koné");
    expect(text).toContain("5 000 XOF");
    expect(text).toContain("Chez Awa");
    expect(text).toContain("8 jours");

    await recordReminderSent(device.db!, late8, 7);
    await recordReminderSent(device.db!, late8, 7); // doublon sans effet
    expect((await listDueReminders(device.db!, now)).map((d) => d.creditId)).toEqual([late40]);
    // 8 jours plus tard : l'étape suivante (15) apparaît pour cette créance.
    const later = new Date(2026, 10, 28, 10, 0, 0);
    expect((await listDueReminders(device.db!, later)).find((d) => d.creditId === late8)?.step).toBe(15);
  });

  it("une créance sans échéance est relancée 15 jours après sa création", async () => {
    useDevice(device);
    const client = await device.db!.insert(schema.customers).values({ fullName: "Sans échéance", phone: "0101010101" }).returning().get();
    const id = await credit(client.id, 3000, null);
    const created = new Date();
    expect((await listDueReminders(device.db!, created)).some((d) => d.creditId === id)).toBe(false);
    const in20 = new Date(created.getTime() + 20 * 86400000);
    expect((await listDueReminders(device.db!, in20)).find((d) => d.creditId === id)?.step).toBe(1); // échéance supposée J+15 : 5 jours de retard
    const in24 = new Date(created.getTime() + 24 * 86400000);
    expect((await listDueReminders(device.db!, in24)).find((d) => d.creditId === id)?.step).toBe(7); // 9 jours de retard
  });

  it("une alerte par jour au patron, jamais deux fois", async () => {
    useDevice(device);
    const now = new Date(2026, 10, 20, 10, 0, 0);
    expect(await queueReminderDigest(device.db!, now, "Chez Awa")).toBe(true);
    expect(await queueReminderDigest(device.db!, now, "Chez Awa")).toBe(false);
    const digest = (await listRecentAlerts(device.db!)).find((a) => a.key === "reminders:2026-11-20")!;
    expect(digest.text.startsWith("[Chez Awa] ")).toBe(true);
    expect(await queueReminderDigest(device.db!, new Date(2026, 8, 1), "x")).toBe(false); // rien d'échu à cette date
  });
});
