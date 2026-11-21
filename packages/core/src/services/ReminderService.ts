import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { formatMoneyPlain, t } from "@gestion-boutique/i18n";
import { and, eq, gt, inArray, ne } from "drizzle-orm";
import { utcToLocalDay } from "../domain/localDay";
import { enqueueAlert, localDayString } from "./AlertService";

// Relances de créances échelonnées. Sans serveur, WariBox ne peut pas écrire aux clients tout seul : il décide
// QUI relancer, QUAND et sur QUEL ton, et prépare le message (WhatsApp en un geste). Chaque relance envoyée est
// notée : la suivante n'apparaît qu'à l'échéance de l'étape suivante, jamais deux fois la même.

/** Jours de retard auxquels une relance est due : rappel aimable, relance, relance ferme, dernier avis. */
export const REMINDER_SCHEDULE_DAYS = [1, 7, 15, 30] as const;
/** Délai de paiement supposé pour une créance sans échéance saisie (à partir de sa création). */
export const DEFAULT_CREDIT_TERM_DAYS = 15;

export type ReminderTone = "gentle" | "firm" | "final";

export function reminderTone(step: number): ReminderTone {
  if (step < 7) return "gentle";
  if (step < 30) return "firm";
  return "final";
}

/**
 * Étape de relance à faire maintenant, ou null. Si plusieurs étapes sont échues sans avoir été envoyées (le patron
 * n'a pas relancé pendant 3 semaines), seule la plus avancée compte : un rappel aimable n'a plus de sens. Une étape
 * inférieure à une étape déjà envoyée est dépassée.
 */
export function nextReminderStep(daysLate: number, sentSteps: number[], schedule: readonly number[] = REMINDER_SCHEDULE_DAYS): number | null {
  const maxSent = sentSteps.length > 0 ? Math.max(...sentSteps) : 0;
  const candidates = schedule.filter((step) => step <= daysLate && step > maxSent);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function daysBetween(fromDay: string, toDay: string): number {
  const a = Date.parse(`${fromDay}T12:00:00Z`);
  const b = Date.parse(`${toDay}T12:00:00Z`);
  return Math.floor((b - a) / 86400000);
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export interface DueReminder {
  creditId: number;
  customerId: number;
  customerName: string;
  phone: string | null;
  amount: number;
  /** Jour d'échéance (saisi, ou création + délai supposé). */
  dueDay: string;
  daysLate: number;
  step: number;
  tone: ReminderTone;
  reference: string;
}

/** Les relances à faire aujourd'hui, les plus en retard d'abord. */
export async function listDueReminders(db: Database, now: Date = new Date()): Promise<DueReminder[]> {
  const today = localDayString(now);
  const credits = await db
    .select()
    .from(schema.customerCredits)
    .where(and(ne(schema.customerCredits.status, "settled"), gt(schema.customerCredits.remainingBalance, 0)));
  if (credits.length === 0) return [];

  const customers = await db.select().from(schema.customers).where(inArray(schema.customers.id, [...new Set(credits.map((c) => c.customerId))]));
  const customerById = new Map(customers.map((c) => [c.id, c] as const));
  const saleIds = credits.map((c) => c.saleId).filter((v): v is number => v != null);
  const orderIds = credits.map((c) => c.serviceOrderId).filter((v): v is number => v != null);
  const sales = saleIds.length > 0 ? await db.select({ id: schema.sales.id, number: schema.sales.number }).from(schema.sales).where(inArray(schema.sales.id, saleIds)) : [];
  const orders = orderIds.length > 0 ? await db.select({ id: schema.serviceOrders.id, number: schema.serviceOrders.number }).from(schema.serviceOrders).where(inArray(schema.serviceOrders.id, orderIds)) : [];
  const saleNumber = new Map(sales.map((s) => [s.id, s.number] as const));
  const orderNumber = new Map(orders.map((o) => [o.id, o.number] as const));
  const logged = await db.select().from(schema.creditReminders).where(inArray(schema.creditReminders.creditId, credits.map((c) => c.id)));
  const stepsByCredit = new Map<number, number[]>();
  for (const row of logged) stepsByCredit.set(row.creditId, [...(stepsByCredit.get(row.creditId) ?? []), row.step]);

  const due: DueReminder[] = [];
  for (const credit of credits) {
    const customer = customerById.get(credit.customerId);
    if (!customer) continue;
    const dueDay = credit.dueDate ? credit.dueDate.slice(0, 10) : addDays(utcToLocalDay(credit.createdAt), DEFAULT_CREDIT_TERM_DAYS);
    const daysLate = daysBetween(dueDay, today);
    const step = nextReminderStep(daysLate, stepsByCredit.get(credit.id) ?? []);
    if (step === null) continue;
    due.push({
      creditId: credit.id,
      customerId: customer.id,
      customerName: customer.fullName,
      phone: customer.phone?.trim() || null,
      amount: credit.remainingBalance,
      dueDay,
      daysLate,
      step,
      tone: reminderTone(step),
      reference: (credit.saleId != null ? saleNumber.get(credit.saleId) : credit.serviceOrderId != null ? orderNumber.get(credit.serviceOrderId) : undefined) ?? "",
    });
  }
  return due.sort((a, b) => b.daysLate - a.daysLate);
}

/** Texte de la relance, au ton de l'étape. */
export function buildReminderText(reminder: DueReminder, businessName?: string | null): string {
  return t(`reminders.${reminder.tone}`, {
    customerName: reminder.customerName,
    amount: formatMoneyPlain(reminder.amount),
    business: businessName?.trim() || t("whatsapp.defaultBusinessName"),
    reference: reminder.reference || "—",
    daysLate: reminder.daysLate,
    dueDate: reminder.dueDay,
  });
}

/** Note qu'une relance est partie (une seule ligne par créance et par étape). */
export async function recordReminderSent(db: Database, creditId: number, step: number, channel: "whatsapp" | "other" = "whatsapp"): Promise<void> {
  await db.insert(schema.creditReminders).values({ creditId, step, channel }).onConflictDoNothing().run();
}

/** Les relances déjà faites pour une créance, pour l'historique. */
export function listRemindersOf(db: Database, creditId: number) {
  return db.select().from(schema.creditReminders).where(eq(schema.creditReminders.creditId, creditId));
}

/**
 * Une alerte par jour au patron : « N relances de créances à envoyer aujourd'hui ». Sans effet s'il n'y en a pas
 * ou si l'alerte du jour existe déjà.
 */
export async function queueReminderDigest(db: Database, now: Date = new Date(), businessName?: string | null): Promise<boolean> {
  const due = await listDueReminders(db, now);
  if (due.length === 0) return false;
  const total = due.reduce((sum, r) => sum + r.amount, 0);
  const prefix = businessName?.trim() ? `[${businessName.trim()}] ` : "";
  return enqueueAlert(db, {
    key: `reminders:${localDayString(now)}`,
    severity: "info",
    text: `${prefix}${t("reminders.digest", { count: due.length, total: formatMoneyPlain(total) })}`,
  });
}
