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
  flags: ControlFlag[];
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
  kind: "refund" | "loss" | "manual_entry" | "cash_variance" | "price_alert" | "credit_approved" | "stock_count";
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

export interface ControlsReport {
  from: string;
  to: string;
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

  const [users, sales, refunds, credits, serviceOrders, movements, locations, sessions, audits, purchases, purchaseItems, suppliers, debts, variants, products, counts, settings] =
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
        flags: [],
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
    if (e.refundRate >= CONTROL_THRESHOLDS.refundRatePercent && e.refundedOnOwnSalesTotal > 0) {
      const count = refunds.filter((r) => inRange(r.createdAt) && saleById.get(r.saleId)?.userId === e.userId).length;
      if (count >= CONTROL_THRESHOLDS.refundMinCount) e.flags.push({ code: "refund_rate", severity: "warning", value: e.refundRate });
    }
    if (e.cashAlerts > 0) e.flags.push({ code: "cash_variance", severity: Math.abs(e.cashVariance) > cashThreshold * 5 && e.cashVariance < 0 ? "danger" : "warning", value: e.cashVariance });
    if (e.salesTotal > 0 && (e.lossValue / e.salesTotal) * 100 >= CONTROL_THRESHOLDS.lossRatePercent) e.flags.push({ code: "loss_rate", severity: "warning", value: (e.lossValue / e.salesTotal) * 100 });
    else if (e.salesTotal === 0 && e.lossValue > 0) e.flags.push({ code: "loss_rate", severity: "warning", value: e.lossValue });
    if (e.manualEntryCount >= CONTROL_THRESHOLDS.manualEntryCount) e.flags.push({ code: "manual_entries", severity: "warning", value: e.manualEntryCount });
    if (e.failedApprovals >= CONTROL_THRESHOLDS.failedApprovals) e.flags.push({ code: "failed_approvals", severity: "danger", value: e.failedApprovals });
    if (e.priceChanges >= CONTROL_THRESHOLDS.priceChanges) e.flags.push({ code: "price_changes", severity: "warning", value: e.priceChanges });
    if (e.expenseEdits >= CONTROL_THRESHOLDS.expenseEdits) e.flags.push({ code: "expense_edits", severity: "warning", value: e.expenseEdits });
  }
  for (const s of supplierMap.values()) {
    s.shortfallValue = roundMoney(s.shortfallValue);
    if (s.priceAlerts > 0) s.flags.push({ code: "supplier_price_alert", severity: "warning", value: s.priceAlerts });
    if (s.shortfallValue > 0) s.flags.push({ code: "supplier_shortfall", severity: "danger", value: s.shortfallValue });
    if (s.sameUserReceipts > 0) s.flags.push({ code: "supplier_same_user_receipt", severity: "warning", value: s.sameUserReceipts });
  }

  const employees = [...emps.values()]
    .filter((e) => e.salesCount + e.refundsProcessed + e.creditCount + e.lossCount + e.manualEntryCount + e.cashSessions + e.failedApprovals + e.priceChanges + e.expenseEdits + e.approvalsGiven > 0)
    .sort((a, b) => b.flags.length - a.flags.length || b.salesTotal - a.salesTotal);

  return {
    from: range.from,
    to: range.to,
    employees,
    suppliers: [...supplierMap.values()].sort((a, b) => b.flags.length - a.flags.length || b.purchasesTotal - a.purchasesTotal),
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
