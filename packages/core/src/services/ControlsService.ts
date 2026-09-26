import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { roundMoney } from "../domain/money";
import { getStockCountReport } from "./InventoryService";
import { getSettings } from "./SettingsService";

// Tableau de bord "Contrôles" : indicateurs d'anomalies par employé et par
// fournisseur sur une période — pas une accusation, des signaux à vérifier. Les
// seuils de signalement ci-dessous sont volontairement simples et affichés.
export const CONTROL_THRESHOLDS = {
  // Part des ventes d'un employé qui a été remboursée (%), avec au moins 2 remboursements.
  refundRatePercent: 5,
  refundMinCount: 2,
  // Valeur des pertes déclarées par rapport à ses ventes (%).
  lossRatePercent: 2,
  // Nombre d'entrées de stock manuelles sur la période.
  manualEntryCount: 3,
  // Tentatives d'approbation échouées.
  failedApprovals: 3,
  // Modifications de prix / de dépenses.
  priceChanges: 3,
  expenseEdits: 3,
};

export type ControlFlagCode =
  | "refund_rate"
  | "cash_variance"
  | "loss_rate"
  | "manual_entries"
  | "failed_approvals"
  | "price_changes"
  | "expense_edits"
  | "discount_rate"
  | "rejected_approvals"
  | "low_tickets"
  | "ticket_cancels"
  | "stale_tickets"
  | "unpaid_pickups"
  | "number_gaps"
  | "supplier_price_alert"
  | "supplier_shortfall"
  | "supplier_same_user_receipt";

export interface ControlFlag {
  code: ControlFlagCode;
  severity: "warning" | "danger";
  value: number;
}

export interface EmployeeControl {
  userId: number;
  name: string;
  salesCount: number;
  salesTotal: number;
  refundsProcessed: number;
  refundsProcessedTotal: number;
  refundedOnOwnSalesTotal: number;
  refundRate: number;
  creditCount: number;
  creditTotal: number;
  creditOpen: number;
  lossCount: number;
  lossValue: number;
  manualEntryCount: number;
  manualEntryValue: number;
  cashSessions: number;
  cashVariance: number;
  cashAlerts: number;
  failedApprovals: number;
  approvalsGiven: number;
  priceChanges: number;
  expenseEdits: number;
  // Remises hors promotion programmée (approuvées par un responsable) et leur part des ventes (%).
  unauthorizedDiscountTotal: number;
  discountRate: number;
  approvalsRejected: number;
  // Points de fidélité ajustés à la main (valeur absolue cumulée).
  pointsAdjusted: number;
  ticketsCount: number;
  ticketsTotal: number;
  // Tickets à zéro ou très inférieurs à la moyenne, et tickets annulés par cet employé.
  lowTickets: number;
  ticketCancels: number;
  flags: ControlFlag[];
  // Score de risque 0-100 (voir computeRiskScore) et son niveau.
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
}

export interface SupplierControl {
  supplierId: number;
  name: string;
  purchasesCount: number;
  purchasesTotal: number;
  priceAlerts: number;
  awaitingReceipt: number;
  shortfallValue: number;
  sameUserReceipts: number;
  openDebt: number;
  flags: ControlFlag[];
}

export interface ControlEvent {
  at: string;
  kind: "refund" | "loss" | "manual_entry" | "cash_variance" | "price_alert" | "credit_approved" | "stock_count" | "discount";
  userId: number | null;
  amount: number;
  detail: string;
}

export interface CashVarianceRow {
  sessionId: number;
  userId: number;
  closedAt: string;
  expected: number;
  counted: number;
  difference: number;
  alert: boolean;
}

export interface StockCountSummary {
  countId: number;
  locationId: number;
  closedAt: string | null;
  closedBy: number | null;
  missingValue: number;
  surplusValue: number;
}

// Alerte à traiter en priorité (employé ou fournisseur), triée par gravité.
export interface ControlAlert {
  subject: "employee" | "supplier" | "shop";
  id: number;
  name: string;
  code: ControlFlagCode;
  severity: "warning" | "danger";
  value: number;
}

export interface StaleTicket {
  number: string;
  readyItems: number;
  value: number;
  ageDays: number;
}

export interface UnpaidPickup {
  number: string;
  customerName: string;
  remaining: number;
  closedAt: string | null;
}

export interface NumberGaps {
  kind: "sale" | "ticket";
  missing: string[];
}

export interface ControlsReport {
  from: string;
  to: string;
  alerts: ControlAlert[];
  // Tickets « prêts » jamais retirés, retraits avec solde dû, numéros manquants.
  staleTickets: StaleTicket[];
  unpaidPickups: UnpaidPickup[];
  numberGaps: NumberGaps[];
  employees: EmployeeControl[];
  suppliers: SupplierControl[];
  cashVariances: CashVarianceRow[];
  stockCounts: StockCountSummary[];
  events: ControlEvent[];
}

export interface ControlsRange {
  from: string; // "YYYY-MM-DD"
  to: string;
}

// Numéros manquants dans une séquence « PREFIXE-AAAA-nnnnnn » (par année) : un
// trou veut dire qu'une ligne a été supprimée ou n'a jamais été saisie.
export function findNumberGaps(numbers: string[]): string[] {
  const byPrefix = new Map<string, Set<number>>();
  for (const n of numbers) {
    const match = /^(.+-\d{4}-)(\d+)$/.exec(n);
    if (!match) continue;
    const set = byPrefix.get(match[1]!) ?? new Set<number>();
    set.add(Number(match[2]));
    byPrefix.set(match[1]!, set);
  }
  const missing: string[] = [];
  for (const [prefix, set] of byPrefix) {
    const max = Math.max(...set);
    for (let i = 1; i < max; i++) if (!set.has(i)) missing.push(`${prefix}${String(i).padStart(6, "0")}`);
  }
  return missing;
}

export interface RiskThresholds {
  refundRatePercent: number;
  lossRatePercent: number;
  discountRatePercent: number;
}

// Score de risque 0-100 d'un employé : chaque signal pèse un certain poids et
// atteint la moitié de ce poids au seuil d'alerte, la totalité à deux fois le
// seuil. Un repère de lecture, pas une preuve.
export function computeRiskScore(
  e: Pick<
    EmployeeControl,
    | "refundRate"
    | "salesTotal"
    | "lossValue"
    | "discountRate"
    | "cashAlerts"
    | "cashSessions"
    | "failedApprovals"
    | "manualEntryCount"
    | "approvalsRejected"
    | "priceChanges"
    | "expenseEdits"
  > &
    Partial<Pick<EmployeeControl, "lowTickets" | "ticketCancels">>,
  th: RiskThresholds,
): { score: number; level: "low" | "medium" | "high" } {
  const part = (value: number, threshold: number) => (threshold > 0 ? Math.min(1, value / (threshold * 2)) : value > 0 ? 1 : 0);
  const lossRate = e.salesTotal > 0 ? (e.lossValue / e.salesTotal) * 100 : e.lossValue > 0 ? 100 : 0;
  const cashShare = e.cashSessions > 0 ? e.cashAlerts / e.cashSessions : 0;
  const score = Math.round(
    20 * part(e.refundRate, th.refundRatePercent) +
      20 * part(lossRate, th.lossRatePercent) +
      20 * part(e.discountRate, th.discountRatePercent) +
      20 * Math.min(1, cashShare * 2) +
      5 * Math.min(1, e.failedApprovals / 3) +
      5 * Math.min(1, e.manualEntryCount / 6) +
      5 * Math.min(1, e.approvalsRejected / 4) +
      5 * Math.min(1, (e.priceChanges + e.expenseEdits + (e.lowTickets ?? 0) + (e.ticketCancels ?? 0)) / 6),
  );
  return { score, level: score >= 60 ? "high" : score >= 30 ? "medium" : "low" };
}

function parseMeta(raw: string | null): Record<string, any> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    return {};
  }
}

export async function getControlsReport(db: Database, range: ControlsRange, storeId?: number): Promise<ControlsReport> {
  const from = `${range.from.slice(0, 10)} 00:00:00`;
  const to = `${range.to.slice(0, 10)} 23:59:59`;
  const inRange = (at: string) => at >= from && at <= to;

  const [users, sales, refunds, credits, serviceOrders, movements, locations, sessions, audits, purchases, purchaseItems, suppliers, debts, variants, products, counts, settings, orderItems, customersAll] =
    await Promise.all([
      db.select().from(schema.users),
      db.select().from(schema.sales),
      db.select().from(schema.refunds),
      db.select().from(schema.customerCredits),
      db.select().from(schema.serviceOrders),
      db.select().from(schema.stockMovements),
      db.select().from(schema.stockLocations),
      db.select().from(schema.cashSessions),
      db.select().from(schema.auditLog),
      db.select().from(schema.purchases),
      db.select().from(schema.purchaseItems),
      db.select().from(schema.suppliers),
      db.select().from(schema.supplierDebts),
      db.select().from(schema.productVariants),
      db.select().from(schema.products),
      db.select().from(schema.stockCounts),
      getSettings(db),
      db.select().from(schema.serviceOrderItems),
      db.select().from(schema.customers),
    ]);

  const saleById = new Map(sales.map((s) => [s.id, s] as const));
  const orderById = new Map(serviceOrders.map((o) => [o.id, o] as const));
  const locationStore = new Map(locations.map((l) => [l.id, l.storeId] as const));
  const productById = new Map(products.map((p) => [p.id, p] as const));
  const costByVariant = new Map(variants.map((v) => [v.id, productById.get(v.productId)?.purchasePrice ?? 0] as const));
  const storeOk = (s: number | null | undefined) => !storeId || s === storeId;

  const emps = new Map<number, EmployeeControl>();
  const emp = (userId: number): EmployeeControl => {
    let e = emps.get(userId);
    if (!e) {
      const u = users.find((x) => x.id === userId);
      e = {
        userId,
        name: u?.fullName ?? `#${userId}`,
        salesCount: 0,
        salesTotal: 0,
        refundsProcessed: 0,
        refundsProcessedTotal: 0,
        refundedOnOwnSalesTotal: 0,
        refundRate: 0,
        creditCount: 0,
        creditTotal: 0,
        creditOpen: 0,
        lossCount: 0,
        lossValue: 0,
        manualEntryCount: 0,
        manualEntryValue: 0,
        cashSessions: 0,
        cashVariance: 0,
        cashAlerts: 0,
        failedApprovals: 0,
        approvalsGiven: 0,
        priceChanges: 0,
        expenseEdits: 0,
        unauthorizedDiscountTotal: 0,
        discountRate: 0,
        approvalsRejected: 0,
        pointsAdjusted: 0,
        ticketsCount: 0,
        ticketsTotal: 0,
        lowTickets: 0,
        ticketCancels: 0,
        flags: [],
        riskScore: 0,
        riskLevel: "low",
      };
      emps.set(userId, e);
    }
    return e;
  };

  const events: ControlEvent[] = [];

  // Ventes
  for (const s of sales) {
    if (!inRange(s.createdAt) || !storeOk(s.storeId)) continue;
    const e = emp(s.userId);
    e.salesCount++;
    e.salesTotal += s.total;
  }

  // Remboursements : traités par X, et rattachés au vendeur de la vente d'origine
  for (const r of refunds) {
    if (!inRange(r.createdAt)) continue;
    const sale = saleById.get(r.saleId);
    if (!sale || !storeOk(sale.storeId)) continue;
    const processor = emp(r.userId);
    processor.refundsProcessed++;
    processor.refundsProcessedTotal += r.total;
    emp(sale.userId).refundedOnOwnSalesTotal += r.total;
    if (r.approvedBy != null) emp(r.approvedBy).approvalsGiven++;
    events.push({ at: r.createdAt, kind: "refund", userId: r.userId, amount: r.total, detail: `${sale.number} — ${r.reason ?? ""}` });
  }

  // Tickets de service par employé (annulés exclus) ; « bas » = zéro ou très
  // inférieur à la moyenne de la boutique.
  const liveOrders = serviceOrders.filter((o) => !o.cancelledAt && inRange(o.createdAt) && storeOk(o.storeId));
  const ticketAvg = liveOrders.length > 0 ? liveOrders.reduce((sum, o) => sum + o.total, 0) / liveOrders.length : 0;
  for (const o of liveOrders) {
    const e = emp(o.userId);
    e.ticketsCount++;
    e.ticketsTotal += o.total;
    if (o.total <= 0 || (liveOrders.length >= 5 && o.total < ticketAvg * 0.3)) e.lowTickets++;
  }

  // Crédits accordés (ventes et tickets), rattachés à celui qui les a saisis
  for (const c of credits) {
    if (!inRange(c.createdAt) || !storeOk(c.storeId)) continue;
    const ownerId = c.saleId != null ? saleById.get(c.saleId)?.userId : c.serviceOrderId != null ? orderById.get(c.serviceOrderId)?.userId : undefined;
    if (ownerId == null) continue;
    const e = emp(ownerId);
    e.creditCount++;
    e.creditTotal += c.originalAmount;
    if (c.status !== "settled") e.creditOpen += c.remainingBalance;
    if (c.approvedBy != null) {
      emp(c.approvedBy).approvalsGiven++;
      events.push({ at: c.createdAt, kind: "credit_approved", userId: ownerId, amount: c.originalAmount, detail: "" });
    }
  }

  // Mouvements de stock manuels
  for (const m of movements) {
    if (!inRange(m.createdAt) || m.createdBy == null) continue;
    if (!storeOk(locationStore.get(m.locationId))) continue;
    const cost = costByVariant.get(m.variantId) ?? 0;
    if (m.movementType === "loss") {
      const e = emp(m.createdBy);
      const value = Math.abs(m.quantityDelta) * cost;
      e.lossCount++;
      e.lossValue += value;
      events.push({ at: m.createdAt, kind: "loss", userId: m.createdBy, amount: value, detail: `${m.referenceType ?? ""}${m.note ? " — " + m.note : ""}` });
      if (m.approvedBy != null) emp(m.approvedBy).approvalsGiven++;
    } else if (m.movementType === "adjustment" && m.referenceType === "manual" && m.quantityDelta > 0) {
      const e = emp(m.createdBy);
      const value = m.quantityDelta * cost;
      e.manualEntryCount++;
      e.manualEntryValue += value;
      events.push({ at: m.createdAt, kind: "manual_entry", userId: m.createdBy, amount: value, detail: m.note ?? "" });
      if (m.approvedBy != null) emp(m.approvedBy).approvalsGiven++;
    }
  }

  // Sessions de caisse
  const cashVariances: CashVarianceRow[] = [];
  const cashThreshold = settings.cashVarianceThreshold ?? 0;
  for (const c of sessions) {
    if (!c.closedAt || !inRange(c.closedAt) || !storeOk(c.storeId) || c.closingAmount == null || c.expectedAmount == null) continue;
    const difference = roundMoney(c.closingAmount - c.expectedAmount);
    const alert = Math.abs(difference) > cashThreshold;
    const e = emp(c.userId);
    e.cashSessions++;
    e.cashVariance += difference;
    if (alert) {
      e.cashAlerts++;
      events.push({ at: c.closedAt, kind: "cash_variance", userId: c.userId, amount: difference, detail: "" });
    }
    cashVariances.push({ sessionId: c.id, userId: c.userId, closedAt: c.closedAt, expected: c.expectedAmount, counted: c.closingAmount, difference, alert });
  }

  // Journal : approbations refusées, changements de prix, corrections de dépenses, réceptions
  const sameUserReceiptsBySupplier = new Map<number, number>();
  const purchaseById = new Map(purchases.map((p) => [p.id, p] as const));
  for (const a of audits) {
    if (!inRange(a.createdAt)) continue;
    const meta = parseMeta(a.metadata);
    if (a.action === "approval_failed" && a.userId != null) emp(a.userId).failedApprovals++;
    else if (a.action === "update_product" && a.userId != null && meta.changes && (meta.changes.salePrice || meta.changes.purchasePrice)) emp(a.userId).priceChanges++;
    else if ((a.action === "update_expense" || a.action === "delete_expense") && a.userId != null) emp(a.userId).expenseEdits++;
    else if (a.action === "create_sale" && a.userId != null && meta.unauthorizedDiscount > 0) {
      emp(a.userId).unauthorizedDiscountTotal += meta.unauthorizedDiscount;
      if (meta.discountApprovedBy != null) emp(meta.discountApprovedBy).approvalsGiven++;
      events.push({ at: a.createdAt, kind: "discount", userId: a.userId, amount: meta.unauthorizedDiscount, detail: meta.number ?? "" });
    } else if (a.action === "approval_rejected" && a.userId != null) emp(a.userId).approvalsRejected++;
    else if (a.action === "cancel_service_order" && a.userId != null) {
      emp(a.userId).ticketCancels++;
      if (meta.approvedBy != null) emp(meta.approvedBy).approvalsGiven++;
    }
    else if (a.action === "adjust_loyalty_points" && a.userId != null) {
      emp(a.userId).pointsAdjusted += Math.abs(Number(meta.pointsDelta) || 0);
      if (meta.approvedBy != null) emp(meta.approvedBy).approvalsGiven++;
    } else if (a.action === "create_expense" && meta.approvedBy != null) emp(meta.approvedBy).approvalsGiven++;
    else if (a.action === "receive_purchase" && meta.sameUser && a.entityId != null) {
      const p = purchaseById.get(a.entityId);
      if (p) sameUserReceiptsBySupplier.set(p.supplierId, (sameUserReceiptsBySupplier.get(p.supplierId) ?? 0) + 1);
    }
  }

  // Inventaires clôturés dans la période
  const stockCounts: StockCountSummary[] = [];
  for (const c of counts) {
    if (c.status !== "closed" || !c.closedAt || !inRange(c.closedAt) || !storeOk(c.storeId)) continue;
    const report = await getStockCountReport(db, c.id);
    stockCounts.push({ countId: c.id, locationId: c.locationId, closedAt: c.closedAt, closedBy: c.closedBy, missingValue: report.missingValue, surplusValue: report.surplusValue });
    events.push({ at: c.closedAt, kind: "stock_count", userId: c.closedBy, amount: -report.missingValue + report.surplusValue, detail: `#${c.id}` });
  }

  // Fournisseurs
  const supplierMap = new Map<number, SupplierControl>();
  const sup = (supplierId: number): SupplierControl => {
    let s = supplierMap.get(supplierId);
    if (!s) {
      s = {
        supplierId,
        name: suppliers.find((x) => x.id === supplierId)?.name ?? `#${supplierId}`,
        purchasesCount: 0,
        purchasesTotal: 0,
        priceAlerts: 0,
        awaitingReceipt: 0,
        shortfallValue: 0,
        sameUserReceipts: sameUserReceiptsBySupplier.get(supplierId) ?? 0,
        openDebt: debts.filter((d) => d.supplierId === supplierId && d.status !== "settled").reduce((sum, d) => sum + d.remainingBalance, 0),
        flags: [],
      };
      supplierMap.set(supplierId, s);
    }
    return s;
  };
  for (const p of purchases) {
    if (!inRange(p.createdAt) || !storeOk(p.storeId)) continue;
    const s = sup(p.supplierId);
    s.purchasesCount++;
    s.purchasesTotal += p.total;
    if (p.status === "ordered") s.awaitingReceipt++;
    for (const item of purchaseItems.filter((i) => i.purchaseId === p.id)) {
      if (item.priceAlert) {
        s.priceAlerts++;
        events.push({ at: p.createdAt, kind: "price_alert", userId: p.userId, amount: item.unitCost, detail: `${p.number}` });
      }
      if (item.receivedQuantity != null && item.receivedQuantity < item.quantity) {
        s.shortfallValue += (item.quantity - item.receivedQuantity) * item.unitCost;
      }
    }
  }

  // Signalements
  for (const e of emps.values()) {
    e.refundRate = e.salesTotal > 0 ? (e.refundedOnOwnSalesTotal / e.salesTotal) * 100 : 0;
    if (e.refundRate >= settings.alertRefundPercent && e.refundedOnOwnSalesTotal > 0) {
      const count = refunds.filter((r) => inRange(r.createdAt) && saleById.get(r.saleId)?.userId === e.userId).length;
      if (count >= CONTROL_THRESHOLDS.refundMinCount) e.flags.push({ code: "refund_rate", severity: "warning", value: e.refundRate });
    }
    if (e.cashAlerts > 0) e.flags.push({ code: "cash_variance", severity: Math.abs(e.cashVariance) > cashThreshold * 5 && e.cashVariance < 0 ? "danger" : "warning", value: e.cashVariance });
    e.discountRate = e.salesTotal > 0 ? (e.unauthorizedDiscountTotal / e.salesTotal) * 100 : 0;
    if (e.unauthorizedDiscountTotal > 0 && (e.discountRate >= settings.alertDiscountPercent || e.salesTotal === 0)) {
      e.flags.push({ code: "discount_rate", severity: e.discountRate >= settings.alertDiscountPercent * 2 ? "danger" : "warning", value: e.discountRate });
    }
    if (e.approvalsRejected >= 2) e.flags.push({ code: "rejected_approvals", severity: "warning", value: e.approvalsRejected });
    if (e.lowTickets >= 3 && e.lowTickets / Math.max(1, e.ticketsCount) >= 0.2) e.flags.push({ code: "low_tickets", severity: "warning", value: e.lowTickets });
    if (e.ticketCancels >= 2) e.flags.push({ code: "ticket_cancels", severity: "warning", value: e.ticketCancels });
    if (e.salesTotal > 0 && (e.lossValue / e.salesTotal) * 100 >= settings.alertLossPercent) e.flags.push({ code: "loss_rate", severity: "warning", value: (e.lossValue / e.salesTotal) * 100 });
    else if (e.salesTotal === 0 && e.lossValue > 0) e.flags.push({ code: "loss_rate", severity: "warning", value: e.lossValue });
    if (e.manualEntryCount >= CONTROL_THRESHOLDS.manualEntryCount) e.flags.push({ code: "manual_entries", severity: "warning", value: e.manualEntryCount });
    if (e.failedApprovals >= CONTROL_THRESHOLDS.failedApprovals) e.flags.push({ code: "failed_approvals", severity: "danger", value: e.failedApprovals });
    if (e.priceChanges >= CONTROL_THRESHOLDS.priceChanges) e.flags.push({ code: "price_changes", severity: "warning", value: e.priceChanges });
    if (e.expenseEdits >= CONTROL_THRESHOLDS.expenseEdits) e.flags.push({ code: "expense_edits", severity: "warning", value: e.expenseEdits });
    const risk = computeRiskScore(e, {
      refundRatePercent: settings.alertRefundPercent,
      lossRatePercent: settings.alertLossPercent,
      discountRatePercent: settings.alertDiscountPercent,
    });
    // Un signal grave ne doit jamais se lire « risque faible » : plancher à 30 (niveau moyen).
    e.riskScore = e.flags.some((f) => f.severity === "danger") ? Math.max(risk.score, 30) : risk.score;
    e.riskLevel = e.riskScore >= 60 ? "high" : e.riskScore >= 30 ? "medium" : "low";
  }
  for (const s of supplierMap.values()) {
    s.shortfallValue = roundMoney(s.shortfallValue);
    if (s.priceAlerts > 0) s.flags.push({ code: "supplier_price_alert", severity: "warning", value: s.priceAlerts });
    if (s.shortfallValue > 0) s.flags.push({ code: "supplier_shortfall", severity: "danger", value: s.shortfallValue });
    if (s.sameUserReceipts > 0) s.flags.push({ code: "supplier_same_user_receipt", severity: "warning", value: s.sameUserReceipts });
  }

  const employees = [...emps.values()]
    .filter((e) => e.ticketsCount + e.ticketCancels + e.unauthorizedDiscountTotal + e.pointsAdjusted + e.approvalsRejected + e.salesCount + e.refundsProcessed + e.creditCount + e.lossCount + e.manualEntryCount + e.cashSessions + e.failedApprovals + e.priceChanges + e.expenseEdits + e.approvalsGiven > 0)
    .sort((a, b) => b.riskScore - a.riskScore || b.flags.length - a.flags.length || b.salesTotal - a.salesTotal);

  // Tickets prêts jamais retirés (depuis plus de N jours), retraits avec solde dû,
  // numéros manquants — sur tout l'historique : ce sont des situations à traiter.
  const nowMs = Date.now();
  const liveAll = serviceOrders.filter((o) => !o.cancelledAt && storeOk(o.storeId));
  const staleTickets: StaleTicket[] = [];
  const unpaidPickups: UnpaidPickup[] = [];
  const customerName = (id: number | null) => (id == null ? "—" : (customersAll.find((c) => c.id === id)?.fullName ?? `#${id}`));
  for (const o of liveAll) {
    const items = orderItems.filter((i) => i.serviceOrderId === o.id);
    const ageDays = Math.floor((nowMs - Date.parse(o.createdAt.replace(" ", "T") + "Z")) / 86400000);
    const ready = items.filter((i) => i.status === "ready");
    if (ready.length > 0 && ageDays >= settings.staleTicketDays) {
      staleTickets.push({ number: o.number, readyItems: ready.length, value: roundMoney(ready.reduce((sum, i) => sum + i.total, 0)), ageDays });
    }
    if (items.length > 0 && items.every((i) => i.status === "picked_up")) {
      const remaining = credits.filter((c) => c.serviceOrderId === o.id && c.status !== "settled").reduce((sum, c) => sum + c.remainingBalance, 0);
      if (remaining > 0.01) unpaidPickups.push({ number: o.number, customerName: customerName(o.customerId), remaining: roundMoney(remaining), closedAt: o.closedAt });
    }
  }
  staleTickets.sort((a, b) => b.ageDays - a.ageDays);
  unpaidPickups.sort((a, b) => b.remaining - a.remaining);
  const numberGaps: NumberGaps[] = [
    { kind: "sale" as const, missing: findNumberGaps(sales.filter((x) => storeOk(x.storeId)).map((x) => x.number)).slice(0, 20) },
    { kind: "ticket" as const, missing: findNumberGaps(serviceOrders.filter((x) => storeOk(x.storeId)).map((x) => x.number)).slice(0, 20) },
  ].filter((g) => g.missing.length > 0);

  const supplierList = [...supplierMap.values()].sort((a, b) => b.flags.length - a.flags.length || b.purchasesTotal - a.purchasesTotal);
  const alerts: ControlAlert[] = [
    ...employees.flatMap((e) => e.flags.map((f) => ({ subject: "employee" as const, id: e.userId, name: e.name, code: f.code, severity: f.severity, value: f.value }))),
    ...supplierList.flatMap((sp) => sp.flags.map((f) => ({ subject: "supplier" as const, id: sp.supplierId, name: sp.name, code: f.code, severity: f.severity, value: f.value }))),
    ...(staleTickets.length > 0 ? [{ subject: "shop" as const, id: 0, name: "", code: "stale_tickets" as const, severity: "warning" as const, value: staleTickets.length }] : []),
    ...(unpaidPickups.length > 0 ? [{ subject: "shop" as const, id: 0, name: "", code: "unpaid_pickups" as const, severity: "danger" as const, value: unpaidPickups.reduce((sum, u) => sum + u.remaining, 0) }] : []),
    ...(numberGaps.length > 0 ? [{ subject: "shop" as const, id: 0, name: "", code: "number_gaps" as const, severity: "danger" as const, value: numberGaps.reduce((sum, g) => sum + g.missing.length, 0) }] : []),
  ].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "danger" ? -1 : 1));

  return {
    from: range.from,
    to: range.to,
    alerts,
    staleTickets,
    unpaidPickups,
    numberGaps,
    employees,
    suppliers: supplierList,
    cashVariances: cashVariances.sort((a, b) => b.closedAt.localeCompare(a.closedAt)),
    stockCounts,
    events: events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60),
  };
}

export interface PriceComparisonRow {
  variantId: number;
  productName: string;
  suppliers: { supplierId: number; name: string; lastCost: number; avgCost: number; minCost: number; count: number }[];
  cheapestSupplierId: number | null;
}

// Comparatif des prix d'achat d'un même produit entre fournisseurs.
export async function getSupplierPriceComparison(db: Database): Promise<PriceComparisonRow[]> {
  const [items, purchases, suppliers, variants, products] = await Promise.all([
    db.select().from(schema.purchaseItems),
    db.select().from(schema.purchases),
    db.select().from(schema.suppliers),
    db.select().from(schema.productVariants),
    db.select().from(schema.products),
  ]);
  const purchaseById = new Map(purchases.map((p) => [p.id, p] as const));
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name] as const));
  const productName = new Map(variants.map((v) => [v.id, products.find((p) => p.id === v.productId)?.name ?? `#${v.id}`] as const));

  const byVariant = new Map<number, Map<number, { costs: number[] }>>();
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    const purchase = purchaseById.get(item.purchaseId);
    if (!purchase) continue;
    const perSupplier = byVariant.get(item.variantId) ?? new Map<number, { costs: number[] }>();
    const entry = perSupplier.get(purchase.supplierId) ?? { costs: [] };
    entry.costs.push(item.unitCost);
    perSupplier.set(purchase.supplierId, entry);
    byVariant.set(item.variantId, perSupplier);
  }

  const rows: PriceComparisonRow[] = [];
  for (const [variantId, perSupplier] of byVariant) {
    const list = [...perSupplier.entries()].map(([supplierId, { costs }]) => ({
      supplierId,
      name: supplierName.get(supplierId) ?? `#${supplierId}`,
      lastCost: costs[costs.length - 1]!,
      avgCost: roundMoney(costs.reduce((s, c) => s + c, 0) / costs.length),
      minCost: Math.min(...costs),
      count: costs.length,
    }));
    const cheapest = [...list].sort((a, b) => a.lastCost - b.lastCost)[0];
    rows.push({ variantId, productName: productName.get(variantId) ?? `#${variantId}`, suppliers: list, cheapestSupplierId: cheapest?.supplierId ?? null });
  }
  return rows.sort((a, b) => b.suppliers.length - a.suppliers.length || a.productName.localeCompare(b.productName));
}
