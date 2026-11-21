import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { formatMoneyPlain, t } from "@gestion-boutique/i18n";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import {
  isAlertSeverity,
  isValidSummaryTime,
  meetsSeverity,
  shouldRenotify,
  summaryTimeMinutes,
  type AlertSeverity,
} from "../domain/alertChannel";
import { buildDailySummaryText, getDailySummary } from "./DailySummaryService";
import { CONTROL_THRESHOLDS, getControlsReport, type ControlFlagCode } from "./ControlsService";

// Alertes proactives au patron absent : ce qui mérite son attention est détecté tout seul et mis en file
// (`__alert_outbox`), puis envoyé par le canal automatique configuré ou, à défaut, par WhatsApp en un geste
// depuis l'écran Contrôles. Trois sources :
//   1. les ÉVÉNEMENTS du journal d'audit (remise hors promotion, ticket annulé, remboursement, écart de caisse,
//      perte de stock) — examinés au fil de l'eau, une seule fois chacun ;
//   2. les SIGNAUX du tableau de bord Contrôles (score de risque, numéros manquants...) — examinés toutes les
//      30 minutes, renvoyés seulement s'ils s'aggravent ou persistent plus d'une semaine ;
//   3. le RÉSUMÉ DU JOUR, à l'heure programmée.

const AGGREGATE_INTERVAL_MS = 30 * 60 * 1000;
const AUDIT_BATCH = 500;
export const MAX_ALERT_ATTEMPTS = 5;

type AlertRow = typeof schema.alertOutbox.$inferSelect;

async function getState(db: Database, key: string): Promise<string | null> {
  const row = await db.select().from(schema.alertState).where(eq(schema.alertState.key, key)).get();
  return row?.value ?? null;
}

async function setState(db: Database, key: string, value: string): Promise<void> {
  await db.insert(schema.alertState).values({ key, value }).onConflictDoUpdate({ target: schema.alertState.key, set: { value } }).run();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Jour local « AAAA-MM-JJ ». */
export function localDayString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseMeta(raw: string | null): Record<string, any> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    return {};
  }
}

export interface AuditRowLite {
  id: number;
  userId: number | null;
  action: string;
  metadata: string | null;
}

/** Message d'alerte pour une ligne du journal d'audit, ou null si cette action n'en mérite pas. */
export function eventAlertFromAudit(row: AuditRowLite, names: Map<number, string>): { severity: AlertSeverity; text: string } | null {
  const meta = parseMeta(row.metadata);
  const who = (row.userId != null ? names.get(row.userId) : undefined) ?? t("alerts.someone");
  const money = (v: unknown) => formatMoneyPlain(Number(v) || 0);

  if ((row.action === "create_sale" || row.action === "create_service_order") && Number(meta.unauthorizedDiscount) > 0) {
    const approver = meta.discountApprovedBy != null ? names.get(Number(meta.discountApprovedBy)) : undefined;
    return {
      severity: "warning",
      text: t(approver ? "alerts.event.discountApproved" : "alerts.event.discount", { amount: money(meta.unauthorizedDiscount), number: String(meta.number ?? ""), who, approver: approver ?? "" }),
    };
  }
  if (row.action === "cancel_service_order") {
    return { severity: "warning", text: t("alerts.event.ticketCancelled", { number: String(meta.number ?? ""), amount: money(meta.total), who, reason: String(meta.reason ?? "—") }) };
  }
  if (row.action === "create_refund") {
    return { severity: "warning", text: t("alerts.event.refund", { amount: money(meta.total), number: String(meta.saleNumber ?? ""), who, reason: String(meta.reason ?? "—") }) };
  }
  if (row.action === "close_cash_session" && meta.alert === true) {
    return {
      severity: "danger",
      text: t("alerts.event.cashVariance", { difference: money(meta.difference), expected: money(meta.expectedAmount), counted: money(meta.closingAmount), who }),
    };
  }
  if (row.action === "stock_loss" && Number(meta.value) > 0) {
    return { severity: "warning", text: t("alerts.event.stockLoss", { value: money(meta.value), reason: t(`journals.lossReasons.${meta.reason}`, { defaultValue: String(meta.reason ?? "—") }), who }) };
  }
  return null;
}

export interface QueueOptions {
  minSeverity: AlertSeverity;
  businessName?: string | null;
}

function withPrefix(text: string, businessName?: string | null): string {
  const name = businessName?.trim();
  return name ? `[${name}] ${text}` : text;
}

/** Met une alerte en file ; sans effet si une alerte de même clé y est déjà. */
export async function enqueueAlert(db: Database, input: { key: string; severity: AlertSeverity; text: string }): Promise<boolean> {
  const existing = await db.select({ id: schema.alertOutbox.id }).from(schema.alertOutbox).where(eq(schema.alertOutbox.key, input.key)).get();
  if (existing) return false;
  await db.insert(schema.alertOutbox).values({ key: input.key, severity: input.severity, text: input.text }).run();
  return true;
}

/**
 * Examine les lignes du journal d'audit apparues depuis le dernier passage. Au tout premier passage, rien n'est
 * envoyé : on se place simplement à la fin de l'historique (sinon la première activation réveillerait le patron
 * avec des mois d'événements).
 */
export async function collectEventAlerts(db: Database, options: QueueOptions): Promise<number> {
  const cursorRaw = await getState(db, "auditCursor");
  if (cursorRaw === null) {
    const last = await db.select({ id: schema.auditLog.id }).from(schema.auditLog).orderBy(desc(schema.auditLog.id)).limit(1).get();
    await setState(db, "auditCursor", String(last?.id ?? 0));
    return 0;
  }
  const cursor = Number(cursorRaw);
  const rows = await db
    .select({ id: schema.auditLog.id, userId: schema.auditLog.userId, action: schema.auditLog.action, metadata: schema.auditLog.metadata })
    .from(schema.auditLog)
    .where(gt(schema.auditLog.id, cursor))
    .orderBy(asc(schema.auditLog.id))
    .limit(AUDIT_BATCH);
  if (rows.length === 0) return 0;

  const users = await db.select({ id: schema.users.id, fullName: schema.users.fullName }).from(schema.users);
  const names = new Map(users.map((u) => [u.id, u.fullName] as const));
  let queued = 0;
  for (const row of rows) {
    const alert = eventAlertFromAudit(row, names);
    if (alert && meetsSeverity(alert.severity, options.minSeverity)) {
      if (await enqueueAlert(db, { key: `evt:${row.id}`, severity: alert.severity, text: withPrefix(alert.text, options.businessName) })) queued++;
    }
  }
  await setState(db, "auditCursor", String(rows[rows.length - 1]!.id));
  return queued;
}

export interface FlagThresholds {
  refund: number;
  loss: number;
  discount: number;
  staleDays: number;
  pendingHours: number;
}

/** Texte d'un signal du tableau de bord Contrôles (mêmes phrases que l'écran). */
export function describeControlFlag(code: ControlFlagCode, value: number, th: FlagThresholds): string {
  const params: Record<string, string | number> = { value: Math.round(value * 10) / 10, amount: formatMoneyPlain(value), threshold: 0 };
  if (code === "refund_rate") params.threshold = th.refund;
  if (code === "loss_rate") params.threshold = th.loss;
  if (code === "discount_rate") params.threshold = th.discount;
  if (code === "stale_tickets") params.threshold = th.staleDays;
  if (code === "pending_approvals") params.threshold = th.pendingHours;
  if (code === "manual_entries") params.threshold = CONTROL_THRESHOLDS.manualEntryCount;
  if (code === "failed_approvals") params.threshold = CONTROL_THRESHOLDS.failedApprovals;
  if (code === "price_changes") params.threshold = CONTROL_THRESHOLDS.priceChanges;
  if (code === "expense_edits") params.threshold = CONTROL_THRESHOLDS.expenseEdits;
  return t(`controls.flags.${code}`, params);
}

/**
 * Examine les signaux du tableau de bord Contrôles (30 derniers jours). Lourd (plusieurs lectures complètes) :
 * au plus une fois toutes les 30 minutes, sauf `force`. À n'appeler que sur le Maître ou en mode Solo — un appareil
 * relié verrait les mêmes signaux et les enverrait en double.
 */
export async function collectAggregateAlerts(
  db: Database,
  options: QueueOptions & { now?: Date; thresholds: FlagThresholds; force?: boolean },
): Promise<number> {
  const now = options.now ?? new Date();
  const last = Number((await getState(db, "aggregateAt")) ?? 0);
  if (!options.force && now.getTime() - last < AGGREGATE_INTERVAL_MS) return 0;
  await setState(db, "aggregateAt", String(now.getTime()));

  const day = localDayString(now);
  const from = localDayString(new Date(now.getTime() - 29 * 86400000));
  const report = await getControlsReport(db, { from, to: day });
  let queued = 0;
  for (const alert of report.alerts) {
    if (!meetsSeverity(alert.severity, options.minSeverity)) continue;
    const base = `${alert.subject}:${alert.id}:${alert.code}`;
    const previousRaw = await getState(db, `agg:${base}`);
    let previous: { value: number; severity: AlertSeverity; at: string } | null = null;
    if (previousRaw) {
      try {
        const parsed = JSON.parse(previousRaw) as { value: number; severity: string; at: string };
        if (isAlertSeverity(parsed.severity)) previous = { value: parsed.value, severity: parsed.severity, at: parsed.at };
      } catch {
        previous = null;
      }
    }
    if (!shouldRenotify(previous, { value: alert.value, severity: alert.severity }, now)) continue;
    const flag = describeControlFlag(alert.code, alert.value, options.thresholds);
    const subject = t(`alerts.subject.${alert.subject}`);
    const text = withPrefix(alert.name ? t("alerts.aggregate", { subject, name: alert.name, flag }) : t("alerts.aggregateShop", { flag }), options.businessName);
    if (await enqueueAlert(db, { key: `agg:${base}:${day}`, severity: alert.severity, text })) {
      queued++;
      await setState(db, `agg:${base}`, JSON.stringify({ value: alert.value, severity: alert.severity, at: now.toISOString() }));
    }
  }
  return queued;
}

/** Met en file le résumé de la journée si l'heure programmée est passée et qu'il n'est pas déjà parti. */
export async function queueDailySummaryIfDue(
  db: Database,
  options: { now?: Date; time: string | null | undefined; businessName?: string | null; storeId?: number },
): Promise<boolean> {
  if (!isValidSummaryTime(options.time)) return false;
  const now = options.now ?? new Date();
  if (now.getHours() * 60 + now.getMinutes() < summaryTimeMinutes(options.time)) return false;
  const day = localDayString(now);
  if ((await getState(db, "dailySummarySent")) === day) return false;
  const summary = await getDailySummary(db, day, options.storeId);
  const text = buildDailySummaryText(summary, options.businessName);
  await setState(db, "dailySummarySent", day);
  return enqueueAlert(db, { key: `summary:${day}`, severity: "info", text });
}

// --- file d'envoi ---

/** Alertes pas encore parties, de la plus ancienne à la plus récente (celles qui ont échoué trop souvent sont écartées). */
export function listUnsentAlerts(db: Database, limit = 20): Promise<AlertRow[]> {
  return db
    .select()
    .from(schema.alertOutbox)
    .where(and(isNull(schema.alertOutbox.sentAt), lt(schema.alertOutbox.attempts, MAX_ALERT_ATTEMPTS)))
    .orderBy(asc(schema.alertOutbox.id))
    .limit(limit);
}

export async function countUnsentAlerts(db: Database): Promise<number> {
  const row = await db.select({ n: sql<number>`count(*)` }).from(schema.alertOutbox).where(isNull(schema.alertOutbox.sentAt)).get();
  return Number(row?.n ?? 0);
}

export async function markAlertSent(db: Database, id: number, channel: "url" | "whatsapp"): Promise<void> {
  const sentAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  await db.update(schema.alertOutbox).set({ sentAt, channel, lastError: null }).where(eq(schema.alertOutbox.id, id)).run();
}

export async function markAlertFailed(db: Database, id: number, error: string): Promise<void> {
  await db
    .update(schema.alertOutbox)
    .set({ attempts: sql`${schema.alertOutbox.attempts} + 1`, lastError: error.slice(0, 300) })
    .where(eq(schema.alertOutbox.id, id))
    .run();
}

/** Les dernières alertes (envoyées ou non), la plus récente d'abord — pour l'écran Contrôles. */
export function listRecentAlerts(db: Database, limit = 50): Promise<AlertRow[]> {
  return db.select().from(schema.alertOutbox).orderBy(desc(schema.alertOutbox.id)).limit(limit);
}

/** Remet à zéro le compteur d'échecs : l'utilisateur demande de réessayer. */
export async function retryFailedAlerts(db: Database): Promise<void> {
  await db.update(schema.alertOutbox).set({ attempts: 0 }).where(isNull(schema.alertOutbox.sentAt)).run();
}
