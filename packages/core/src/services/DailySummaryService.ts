import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { formatMoneyPlain, t } from "@gestion-boutique/i18n";
import { roundMoney } from "../domain/money";
import { getControlsReport } from "./ControlsService";
import { getSalesSummary } from "./ReportsService";

// Résumé de fin de journée pour un propriétaire qui n'est pas au comptoir : les
// chiffres du jour et, surtout, tout ce qui demande son attention (remises,
// annulations, pertes, écarts de caisse, approbations données). Prévu pour être
// envoyé par WhatsApp en une page.
export interface DailySummary {
  date: string; // "YYYY-MM-DD"
  salesCount: number;
  salesTotal: number;
  ticketsCount: number;
  ticketsTotal: number;
  refundsCount: number;
  refundsTotal: number;
  discountCount: number;
  discountTotal: number;
  lossCount: number;
  lossValue: number;
  entryCount: number;
  entryValue: number;
  expensesCount: number;
  expensesTotal: number;
  cashSessionsClosed: number;
  cashVariance: number;
  ticketsCancelled: number;
  approvalsCount: number;
  alertsCount: number;
  dangerAlerts: number;
}

function parseMeta(raw: string | null): Record<string, any> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    return {};
  }
}

export async function getDailySummary(db: Database, date: string, storeId?: number): Promise<DailySummary> {
  const day = date.slice(0, 10);
  const from = `${day} 00:00:00`;
  const to = `${day} 23:59:59`;
  const inDay = (at: string) => at >= from && at <= to;

  const [sales, orders, refunds, movements, locations, expenses, sessions, audits, variants, products] = await Promise.all([
    getSalesSummary(db, { from: day, to: day }, storeId),
    db.select().from(schema.serviceOrders),
    db.select().from(schema.refunds),
    db.select().from(schema.stockMovements),
    db.select().from(schema.stockLocations),
    db.select().from(schema.expenses),
    db.select().from(schema.cashSessions),
    db.select().from(schema.auditLog),
    db.select().from(schema.productVariants),
    db.select().from(schema.products),
  ]);
  const storeOk = (s: number | null | undefined) => !storeId || s === storeId;
  const locationStore = new Map(locations.map((l) => [l.id, l.storeId] as const));
  const productCost = new Map(products.map((p) => [p.id, p.purchasePrice] as const));
  const costOfVariant = new Map(variants.map((v) => [v.id, productCost.get(v.productId) ?? 0] as const));

  const dayOrders = orders.filter((o) => inDay(o.createdAt) && storeOk(o.storeId) && !o.cancelledAt);
  const dayRefunds = refunds.filter((r) => inDay(r.createdAt));

  let lossCount = 0;
  let lossValue = 0;
  let entryCount = 0;
  let entryValue = 0;
  for (const m of movements) {
    if (!inDay(m.createdAt) || !storeOk(locationStore.get(m.locationId))) continue;
    const cost = costOfVariant.get(m.variantId) ?? 0;
    if (m.movementType === "loss") {
      lossCount++;
      lossValue += Math.abs(m.quantityDelta) * cost;
    } else if (m.movementType === "adjustment" && m.referenceType === "manual" && m.quantityDelta > 0) {
      entryCount++;
      entryValue += m.quantityDelta * cost;
    }
  }

  const dayExpenses = expenses.filter((e) => e.expenseDate === day && storeOk(e.storeId));
  const daySessions = sessions.filter((c) => c.closedAt && inDay(c.closedAt) && storeOk(c.storeId) && c.closingAmount != null && c.expectedAmount != null);

  let discountCount = 0;
  let discountTotal = 0;
  let ticketsCancelled = 0;
  let approvalsCount = 0;
  for (const a of audits) {
    if (!inDay(a.createdAt)) continue;
    const meta = parseMeta(a.metadata);
    if ((a.action === "create_sale" || a.action === "create_service_order") && meta.unauthorizedDiscount > 0) {
      discountCount++;
      discountTotal += meta.unauthorizedDiscount;
    }
    if (a.action === "cancel_service_order") ticketsCancelled++;
    if (meta.approvedBy != null || meta.discountApprovedBy != null) approvalsCount++;
  }

  const controls = await getControlsReport(db, { from: new Date(Date.parse(`${day}T12:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10), to: day }, storeId);

  return {
    date: day,
    salesCount: sales.saleCount,
    salesTotal: roundMoney(sales.totalRevenue),
    ticketsCount: dayOrders.length,
    ticketsTotal: roundMoney(dayOrders.reduce((sum, o) => sum + o.total, 0)),
    refundsCount: dayRefunds.length,
    refundsTotal: roundMoney(dayRefunds.reduce((sum, r) => sum + r.total, 0)),
    discountCount,
    discountTotal: roundMoney(discountTotal),
    lossCount,
    lossValue: roundMoney(lossValue),
    entryCount,
    entryValue: roundMoney(entryValue),
    expensesCount: dayExpenses.length,
    expensesTotal: roundMoney(dayExpenses.reduce((sum, e) => sum + e.amount, 0)),
    cashSessionsClosed: daySessions.length,
    cashVariance: roundMoney(daySessions.reduce((sum, c) => sum + (c.closingAmount! - c.expectedAmount!), 0)),
    ticketsCancelled,
    approvalsCount,
    alertsCount: controls.alerts.length,
    dangerAlerts: controls.alerts.filter((a) => a.severity === "danger").length,
  };
}

// Texte prêt à envoyer (WhatsApp, SMS, copie) : chiffres en ASCII (formatMoneyPlain).
export function buildDailySummaryText(summary: DailySummary, businessName?: string | null): string {
  const m = (v: number) => formatMoneyPlain(v);
  const lines = [
    businessName?.trim() ? t("dailySummary.title", { date: summary.date, business: businessName.trim() }) : t("dailySummary.titleNoName", { date: summary.date }),
    t("dailySummary.sales", { count: summary.salesCount, total: m(summary.salesTotal) }),
    t("dailySummary.tickets", { count: summary.ticketsCount, total: m(summary.ticketsTotal) }),
    t("dailySummary.expenses", { count: summary.expensesCount, total: m(summary.expensesTotal) }),
    "",
    t("dailySummary.watchTitle"),
    t("dailySummary.discounts", { count: summary.discountCount, total: m(summary.discountTotal) }),
    t("dailySummary.refunds", { count: summary.refundsCount, total: m(summary.refundsTotal) }),
    t("dailySummary.losses", { count: summary.lossCount, total: m(summary.lossValue) }),
    t("dailySummary.entries", { count: summary.entryCount, total: m(summary.entryValue) }),
    t("dailySummary.cancelled", { count: summary.ticketsCancelled }),
    summary.cashSessionsClosed > 0
      ? t("dailySummary.cash", { count: summary.cashSessionsClosed, variance: m(summary.cashVariance) })
      : t("dailySummary.cashNone"),
    t("dailySummary.approvals", { count: summary.approvalsCount }),
    t("dailySummary.alerts", { count: summary.alertsCount, danger: summary.dangerAlerts }),
  ];
  return lines.join("\n");
}

export interface VerificationItem {
  kind: "sale" | "ticket";
  number: string;
  at: string;
  total: number;
  customerName: string;
  phone: string;
}

export interface VerificationSample {
  items: VerificationItem[];
  // Part des opérations de la période sans client identifié (donc invérifiables).
  anonymousPercent: number;
}

// Tirage au sort d'opérations récentes à faire confirmer par le client (appel ou
// message) : un ticket ou une vente que le client ne reconnaît pas, ou dont il
// donne un autre montant, est un signal fort.
export async function getVerificationSample(
  db: Database,
  options: { days?: number; count?: number; storeId?: number; random?: () => number } = {},
): Promise<VerificationSample> {
  const days = options.days ?? 7;
  const count = options.count ?? 5;
  const random = options.random ?? Math.random;
  const since = new Date(Date.now() - days * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const [sales, orders, customers] = await Promise.all([
    db.select().from(schema.sales),
    db.select().from(schema.serviceOrders),
    db.select().from(schema.customers),
  ]);
  const customerById = new Map(customers.map((c) => [c.id, c] as const));
  const storeOk = (s: number | null | undefined) => !options.storeId || s === options.storeId;

  const pool: { kind: "sale" | "ticket"; number: string; at: string; total: number; customerId: number | null }[] = [
    ...sales.filter((s) => s.createdAt >= since && storeOk(s.storeId)).map((s) => ({ kind: "sale" as const, number: s.number, at: s.createdAt, total: s.total, customerId: s.customerId })),
    ...orders.filter((o) => o.createdAt >= since && storeOk(o.storeId) && !o.cancelledAt).map((o) => ({ kind: "ticket" as const, number: o.number, at: o.createdAt, total: o.total, customerId: o.customerId })),
  ];
  const withPhone = pool.filter((p) => p.customerId != null && customerById.get(p.customerId)?.phone);
  // Tirage sans remise (mélange de Fisher-Yates).
  const shuffled = [...withPhone];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return {
    items: shuffled.slice(0, count).map((p) => {
      const c = customerById.get(p.customerId!)!;
      return { kind: p.kind, number: p.number, at: p.at, total: p.total, customerName: c.fullName, phone: c.phone! };
    }),
    anonymousPercent: pool.length > 0 ? Math.round(((pool.length - withPhone.length) / pool.length) * 100) : 0,
  };
}
