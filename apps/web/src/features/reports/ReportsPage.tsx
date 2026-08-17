import {
  buildCashFlowReportExcel,
  buildCashFlowReportPdf,
  buildCashSessionsReportExcel,
  buildCashSessionsReportPdf,
  buildMarginsReportExcel,
  buildMarginsReportPdf,
  buildSalesReportExcel,
  buildSalesReportPdf,
  buildTaxReportExcel,
  buildTaxReportPdf,
  type CashSessionReportRow,
} from "@gestion-boutique/reports";
import { buildServiceOrderTicketPdf, type ServiceOrderTicketData } from "@gestion-boutique/printer";
import {
  getCashFlow,
  getMarginsSummary,
  getProductMarginsBreakdown,
  getSalesSummary,
  getServiceOrderPayment,
  getSettings,
  getTaxCollected,
  getTopProducts,
  hasPermission,
  listCashSessions,
  listCustomers,
  listServiceOrderItems,
  listServiceOrders,
  listStores,
  listUsers,
  projectCashFlow,
  type CashFlow,
  type CashFlowProjection,
  type MarginsSummary,
  type ProductMarginBreakdown,
  type SalesSummary,
  type TaxCollectedSummary,
  type TopProduct,
} from "@gestion-boutique/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { BarChart, LineChart } from "../../components/SimpleChart";
import {
  cardStyle,
  inputStyle,
  pageStyle,
  primaryButtonStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "../../components/sharedStyles";
import { useAuth } from "../auth/useAuth";

type SubTab = "sales" | "margins" | "cashflow" | "tax" | "cash" | "service_orders";

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function timestampForFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

const ABC_COLORS: Record<"A" | "B" | "C", { bg: string; fg: string }> = {
  A: { bg: "rgba(34, 197, 94, 0.18)", fg: "#22c55e" },
  B: { bg: "rgba(234, 179, 8, 0.18)", fg: "#eab308" },
  C: { bg: "rgba(148, 163, 184, 0.2)", fg: "#94a3b8" },
};

function abcBadgeStyle(abcClass: "A" | "B" | "C") {
  return {
    display: "inline-block",
    padding: "2px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    background: ABC_COLORS[abcClass].bg,
    color: ABC_COLORS[abcClass].fg,
  } as const;
}

const secondaryButtonStyle = {
  ...primaryButtonStyle,
  background: "transparent",
  border: "1px solid var(--color-border)",
  color: "var(--color-text)",
  padding: "8px 14px",
  fontSize: 14,
};

export function ReportsPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const { t } = useTranslation();
  const canViewMargins = user ? hasPermission(user.permissions, "view_margins") : false;

  const PAYMENT_STATUS_LABELS: Record<string, string> = {
    paid: t("common.paymentStatus.paid"),
    partial: t("common.paymentStatus.partial"),
    credit: t("common.paymentStatus.credit"),
  };

  const [subTab, setSubTab] = useState<SubTab>("sales");

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const [fromDate, setFromDate] = useState(isoDate(thirtyDaysAgo));
  const [toDate, setToDate] = useState(isoDate(new Date()));

  const [years, setYears] = useState(3);
  const [growthRate, setGrowthRate] = useState(5);

  const [salesSummary, setSalesSummary] = useState<SalesSummary | null>(null);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [marginsSummary, setMarginsSummary] = useState<MarginsSummary | null>(null);
  const [productMargins, setProductMargins] = useState<ProductMarginBreakdown[]>([]);
  const [cashFlow, setCashFlow] = useState<CashFlow | null>(null);
  const [projection, setProjection] = useState<CashFlowProjection | null>(null);
  const [taxEnabled, setTaxEnabled] = useState(false);
  const [taxSummary, setTaxSummary] = useState<TaxCollectedSummary | null>(null);
  const [cashSessions, setCashSessions] = useState<Awaited<ReturnType<typeof listCashSessions>>>([]);
  const [users, setUsers] = useState<Awaited<ReturnType<typeof listUsers>>>([]);
  const [customers, setCustomers] = useState<Awaited<ReturnType<typeof listCustomers>>>([]);
  const [serviceOrders, setServiceOrders] = useState<Awaited<ReturnType<typeof listServiceOrders>>>([]);
  const [serviceOrdersEnabled, setServiceOrdersEnabled] = useState(false);
  const [businessSettings, setBusinessSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(null);
  const [serviceOrderReportError, setServiceOrderReportError] = useState<string | null>(null);
  const [generatingOrderId, setGeneratingOrderId] = useState<number | null>(null);

  const [stores, setStores] = useState<Awaited<ReturnType<typeof listStores>>>([]);
  const [multiStoreEnabled, setMultiStoreEnabled] = useState(false);
  // Vide = "Toutes les boutiques" (agrégé) — seul Admin/Propriétaire
  // (switch_store) voient ce sélecteur ; les autres rôles restent toujours
  // sur leur boutique assignée (currentStoreId), sans choix possible.
  const [reportStoreFilter, setReportStoreFilter] = useState("");
  const canSwitchStore = hasPermission(user?.permissions ?? {}, "switch_store");

  useEffect(() => {
    (async () => {
      const [storeRows, settings] = await Promise.all([listStores(db), getSettings(db)]);
      setStores(storeRows);
      setMultiStoreEnabled(settings.multiStoreEnabled);
    })();
  }, [db]);

  const effectiveStoreId = canSwitchStore
    ? reportStoreFilter === ""
      ? undefined
      : Number(reportStoreFilter)
    : (currentStoreId ?? undefined);

  const range = { from: fromDate, to: toDate };

  const refresh = useCallback(async () => {
    const storeId = effectiveStoreId;
    const [sales, products, margins, productBreakdown, flow, proj, settings, tax, sessions, userRows, customerRows, orderRows] =
      await Promise.all([
        getSalesSummary(db, range, storeId),
        getTopProducts(db, range, 10, storeId),
        getMarginsSummary(db, range, storeId),
        getProductMarginsBreakdown(db, range, storeId),
        getCashFlow(db, range, storeId),
        projectCashFlow(db, { years, growthRate, storeId }),
        getSettings(db),
        getTaxCollected(db, range, storeId),
        listCashSessions(db, { from: fromDate, to: toDate, storeId }),
        listUsers(db),
        listCustomers(db),
        listServiceOrders(db, { from: fromDate, to: toDate, storeId }),
      ]);
    setSalesSummary(sales);
    setTopProducts(products);
    setMarginsSummary(margins);
    setProductMargins(productBreakdown);
    setCashFlow(flow);
    setProjection(proj);
    setTaxEnabled(settings?.taxEnabled ?? false);
    setServiceOrdersEnabled(settings?.enableServiceOrders ?? false);
    setBusinessSettings(settings ?? null);
    setCustomers(customerRows);
    setServiceOrders(orderRows);
    setTaxSummary(tax);
    setCashSessions(sessions);
    setUsers(userRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, fromDate, toDate, years, growthRate, effectiveStoreId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const exportSalesPdf = () => {
    if (!salesSummary) return;
    const blob = buildSalesReportPdf({ from: fromDate, to: toDate, ...salesSummary, topProducts });
    downloadBlob(blob, `rapport-ventes-${fromDate}-${toDate}.pdf`);
  };

  const exportSalesExcel = () => {
    if (!salesSummary) return;
    const blob = buildSalesReportExcel({ from: fromDate, to: toDate, ...salesSummary, topProducts });
    downloadBlob(blob, `rapport-ventes-${fromDate}-${toDate}.xlsx`);
  };

  const exportMarginsPdf = () => {
    if (!marginsSummary) return;
    const blob = buildMarginsReportPdf({
      from: fromDate,
      to: toDate,
      ...marginsSummary,
      productBreakdown: productMargins,
    });
    downloadBlob(blob, `rapport-marges-${fromDate}-${toDate}.pdf`);
  };

  const exportMarginsExcel = () => {
    if (!marginsSummary) return;
    const blob = buildMarginsReportExcel({
      from: fromDate,
      to: toDate,
      ...marginsSummary,
      productBreakdown: productMargins,
    });
    downloadBlob(blob, `rapport-marges-${fromDate}-${toDate}.xlsx`);
  };

  const exportCashFlowPdf = () => {
    if (!cashFlow) return;
    const blob = buildCashFlowReportPdf({ ...cashFlow, projection: projection ?? undefined });
    downloadBlob(blob, `rapport-tresorerie-${fromDate}-${toDate}.pdf`);
  };

  const exportCashFlowExcel = () => {
    if (!cashFlow) return;
    const blob = buildCashFlowReportExcel({ ...cashFlow, projection: projection ?? undefined });
    downloadBlob(blob, `rapport-tresorerie-${fromDate}-${toDate}.xlsx`);
  };

  const exportTaxPdf = () => {
    if (!taxSummary) return;
    const blob = buildTaxReportPdf({ from: fromDate, to: toDate, ...taxSummary });
    downloadBlob(blob, `rapport-tva-${fromDate}-${toDate}.pdf`);
  };

  const exportTaxExcel = () => {
    if (!taxSummary) return;
    const blob = buildTaxReportExcel({ from: fromDate, to: toDate, ...taxSummary });
    downloadBlob(blob, `rapport-tva-${fromDate}-${toDate}.xlsx`);
  };

  const userName = (userId: number) => users.find((u) => u.id === userId)?.fullName ?? "—";

  const cashSessionRows: CashSessionReportRow[] = cashSessions.map((s) => ({
    userName: userName(s.userId),
    openedAt: s.openedAt,
    openingAmount: s.openingAmount,
    closedAt: s.closedAt,
    closingAmount: s.closingAmount,
    expectedAmount: s.expectedAmount,
    difference: s.closingAmount != null && s.expectedAmount != null ? s.closingAmount - s.expectedAmount : null,
  }));

  const exportCashSessionsPdf = () => {
    const blob = buildCashSessionsReportPdf({ from: fromDate, to: toDate, rows: cashSessionRows });
    downloadBlob(blob, `rapport-caisse-${fromDate}-${toDate}.pdf`);
  };

  const exportCashSessionsExcel = () => {
    const blob = buildCashSessionsReportExcel({ from: fromDate, to: toDate, rows: cashSessionRows });
    downloadBlob(blob, `rapport-caisse-${fromDate}-${toDate}.xlsx`);
  };

  const customerName = (customerId: number | null) => customers.find((c) => c.id === customerId)?.fullName ?? null;
  const customerPhone = (customerId: number | null) => customers.find((c) => c.id === customerId)?.phone ?? undefined;

  const handleGenerateServiceOrderReport = async (order: (typeof serviceOrders)[number]) => {
    setServiceOrderReportError(null);
    setGeneratingOrderId(order.id);
    try {
      const [items, payment] = await Promise.all([
        listServiceOrderItems(db, order.id),
        getServiceOrderPayment(db, order.id),
      ]);
      const ticketData: ServiceOrderTicketData = {
        businessName: businessSettings?.businessName ?? undefined,
        businessAddress: businessSettings?.address ?? undefined,
        businessPhone: businessSettings?.phone ?? undefined,
        businessEmail: businessSettings?.email ?? undefined,
        logoDataUrl: businessSettings?.logoDataUrl ?? undefined,
        columns: businessSettings?.receiptColumns,
        orderNumber: order.number,
        date: order.createdAt,
        customerName: customerName(order.customerId) ?? undefined,
        customerPhone: customerPhone(order.customerId),
        lines: items.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          total: item.total,
        })),
        subtotal: order.subtotal,
        tax: order.taxTotal,
        total: order.total,
        amountPaid: payment?.amount ?? order.total,
        promisedDate: order.promisedDate ?? undefined,
        showPromisedDate: businessSettings?.printPromisedDateOnTicket ?? true,
      };
      const blob = buildServiceOrderTicketPdf(ticketData);
      downloadBlob(blob, `rapport-ticket-${order.number}-${timestampForFilename()}.pdf`);
    } catch (err) {
      setServiceOrderReportError(err instanceof Error ? err.message : t("reports.errors.reportFailed"));
    } finally {
      setGeneratingOrderId(null);
    }
  };

  const subTabs: { key: SubTab; label: string }[] = [{ key: "sales", label: t("reports.tabs.sales") }];
  if (canViewMargins) subTabs.push({ key: "margins", label: t("reports.tabs.margins") });
  subTabs.push({ key: "cashflow", label: t("reports.tabs.cashflow") });
  subTabs.push({ key: "cash", label: t("reports.tabs.cash") });
  if (serviceOrdersEnabled) subTabs.push({ key: "service_orders", label: t("reports.tabs.service_orders") });
  if (taxEnabled) subTabs.push({ key: "tax", label: t("reports.tabs.tax") });

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>{t("reports.title")}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {subTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setSubTab(tab.key)}
              style={{
                ...primaryButtonStyle,
                background: subTab === tab.key ? "var(--gradient-accent)" : "transparent",
                color: subTab === tab.key ? "#0f172a" : "var(--color-text)",
                border: subTab === tab.key ? "none" : "1px solid var(--color-border)",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ ...cardStyle, flexDirection: "row", gap: 16, alignItems: "flex-end" }}>
        <label>
          {t("reports.from")}
          <input
            style={inputStyle}
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </label>
        <label>
          {t("reports.to")}
          <input style={inputStyle} type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
        {canSwitchStore && multiStoreEnabled && stores.filter((s) => s.isActive).length > 1 && (
          <label>
            {t("reports.store")}
            <select
              style={inputStyle}
              value={reportStoreFilter}
              onChange={(e) => setReportStoreFilter(e.target.value)}
            >
              <option value="">{t("reports.allStores")}</option>
              {stores
                .filter((s) => s.isActive)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>

      {subTab === "sales" && salesSummary && (
        <>
          <div style={{ display: "flex", gap: 16, marginTop: 24 }}>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("reports.revenue")}</span>
              <strong style={{ fontSize: 22 }}>{salesSummary.totalRevenue.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("reports.saleCount")}</span>
              <strong style={{ fontSize: 22 }}>{salesSummary.saleCount}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("reports.averageBasket")}</span>
              <strong style={{ fontSize: 22 }}>{salesSummary.averageBasket.toFixed(0)}</strong>
            </div>
          </div>

          <div style={cardStyle}>
            <strong>{t("reports.revenueByDay")}</strong>
            <BarChart data={salesSummary.byDay.map((d) => ({ label: d.date.slice(5), value: d.total }))} />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24 }}>
            <strong>{t("reports.topProducts")}</strong>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={secondaryButtonStyle} onClick={exportSalesPdf}>
                {t("reports.exportPdf")}
              </button>
              <button style={secondaryButtonStyle} onClick={exportSalesExcel}>
                {t("reports.exportExcel")}
              </button>
            </div>
          </div>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t("reports.product")}</th>
                <th style={thStyle}>{t("reports.quantity")}</th>
                <th style={thStyle}>{t("reports.revenueColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {topProducts.map((p) => (
                <tr key={p.productId}>
                  <td style={tdStyle}>{p.name}</td>
                  <td style={tdStyle}>{p.quantity}</td>
                  <td style={tdStyle}>{p.revenue.toFixed(0)}</td>
                </tr>
              ))}
              {topProducts.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={3}>
                    {t("reports.noSalesPeriod")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {subTab === "margins" && canViewMargins && marginsSummary && (
        <>
          <div style={{ display: "flex", gap: 16, marginTop: 24 }}>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("reports.marginRevenue")}</span>
              <strong style={{ fontSize: 22 }}>{marginsSummary.revenue.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("reports.marginCost")}</span>
              <strong style={{ fontSize: 22 }}>{marginsSummary.cost.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("reports.margin")}</span>
              <strong style={{ fontSize: 22, color: marginsSummary.margin >= 0 ? "#86efac" : "#f87171" }}>
                {marginsSummary.margin.toFixed(0)} ({marginsSummary.marginRate.toFixed(1)}%)
              </strong>
            </div>
          </div>

          <div style={cardStyle}>
            <strong>{t("reports.marginByDay")}</strong>
            <BarChart data={marginsSummary.byDay.map((d) => ({ label: d.date.slice(5), value: d.margin }))} />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button style={secondaryButtonStyle} onClick={exportMarginsPdf}>
              {t("reports.exportPdf")}
            </button>
            <button style={secondaryButtonStyle} onClick={exportMarginsExcel}>
              {t("reports.exportExcel")}
            </button>
          </div>

          <strong style={{ marginTop: 24, display: "block" }}>
            {t("reports.abcHeading")}
          </strong>
          <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: "4px 0 12px" }}>
            {t("reports.abcHint")}
          </p>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t("reports.product")}</th>
                <th style={thStyle}>{t("reports.quantitySold")}</th>
                <th style={thStyle}>{t("reports.margin")}</th>
                <th style={thStyle}>{t("reports.rate")}</th>
                <th style={thStyle}>{t("reports.cumulativeShare")}</th>
                <th style={thStyle}>{t("reports.abcClass")}</th>
              </tr>
            </thead>
            <tbody>
              {productMargins.map((p) => (
                <tr key={p.productId}>
                  <td style={tdStyle}>{p.name}</td>
                  <td style={tdStyle}>{p.quantity}</td>
                  <td style={{ ...tdStyle, color: p.margin >= 0 ? "#86efac" : "#f87171" }}>
                    {p.margin.toFixed(0)}
                  </td>
                  <td style={tdStyle}>{p.marginRate.toFixed(1)}%</td>
                  <td style={tdStyle}>{p.cumulativeShare.toFixed(1)}%</td>
                  <td style={tdStyle}>
                    <span style={abcBadgeStyle(p.abcClass)}>{p.abcClass}</span>
                  </td>
                </tr>
              ))}
              {productMargins.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={6}>
                    {t("reports.noSalesPeriod")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {subTab === "cashflow" && cashFlow && (
        <>
          <div style={cardStyle}>
            <strong>{t("reports.monthlyCashFlow")}</strong>
            <LineChart data={cashFlow.byMonth.map((m) => ({ label: m.month.slice(5), value: m.net }))} />
          </div>

          <div style={{ ...cardStyle, flexDirection: "row", gap: 16, alignItems: "flex-end" }}>
            <label>
              {t("reports.projectionYears")}
              <select style={inputStyle} value={years} onChange={(e) => setYears(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("reports.annualGrowthRate")}
              <input
                style={inputStyle}
                type="number"
                value={growthRate}
                onChange={(e) => setGrowthRate(Number(e.target.value))}
              />
            </label>
          </div>

          {projection && (
            <>
              <div style={cardStyle}>
                <strong>{t("reports.cashFlowProjection")}</strong>
                <BarChart
                  data={projection.byYear.map((y) => ({ label: `${t("reports.year")} ${y.year}`, value: y.projectedNet }))}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                <button style={secondaryButtonStyle} onClick={exportCashFlowPdf}>
                  {t("reports.exportPdf")}
                </button>
                <button style={secondaryButtonStyle} onClick={exportCashFlowExcel}>
                  {t("reports.exportExcel")}
                </button>
              </div>

              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>{t("reports.year")}</th>
                    <th style={thStyle}>{t("reports.projectedIn")}</th>
                    <th style={thStyle}>{t("reports.projectedOut")}</th>
                    <th style={thStyle}>{t("reports.net")}</th>
                    <th style={thStyle}>{t("reports.cumulative")}</th>
                  </tr>
                </thead>
                <tbody>
                  {projection.byYear.map((y) => (
                    <tr key={y.year}>
                      <td style={tdStyle}>{y.year}</td>
                      <td style={tdStyle}>{y.projectedIn.toFixed(0)}</td>
                      <td style={tdStyle}>{y.projectedOut.toFixed(0)}</td>
                      <td style={{ ...tdStyle, color: y.projectedNet >= 0 ? "#86efac" : "#f87171" }}>
                        {y.projectedNet.toFixed(0)}
                      </td>
                      <td style={tdStyle}>{y.cumulative.toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {subTab === "tax" && taxEnabled && taxSummary && (
        <>
          <div style={{ display: "flex", gap: 16, marginTop: 24 }}>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("reports.netTaxCollected")}</span>
              <strong style={{ fontSize: 22 }}>{taxSummary.totalTaxCollected.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("reports.salesTax")}</span>
              <strong style={{ fontSize: 22 }}>{taxSummary.salesTaxTotal.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("reports.refundedTax")}</span>
              <strong style={{ fontSize: 22 }}>{taxSummary.refundsTaxTotal.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("reports.taxableRevenue")}</span>
              <strong style={{ fontSize: 22 }}>{taxSummary.taxableRevenue.toFixed(0)}</strong>
            </div>
          </div>

          <div style={cardStyle}>
            <strong>{t("reports.taxByDay")}</strong>
            <BarChart data={taxSummary.byDay.map((d) => ({ label: d.date.slice(5), value: d.taxCollected }))} />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button style={secondaryButtonStyle} onClick={exportTaxPdf}>
              {t("reports.exportPdf")}
            </button>
            <button style={secondaryButtonStyle} onClick={exportTaxExcel}>
              {t("reports.exportExcel")}
            </button>
          </div>
        </>
      )}

      {subTab === "cash" && (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}>
            <button style={secondaryButtonStyle} onClick={exportCashSessionsPdf}>
              {t("reports.exportPdf")}
            </button>
            <button style={secondaryButtonStyle} onClick={exportCashSessionsExcel}>
              {t("reports.exportExcel")}
            </button>
          </div>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t("reports.opening")}</th>
                <th style={thStyle}>{t("reports.cashier")}</th>
                <th style={thStyle}>{t("reports.openingAmount")}</th>
                <th style={thStyle}>{t("reports.closing")}</th>
                <th style={thStyle}>{t("reports.closingAmount")}</th>
                <th style={thStyle}>{t("reports.expected")}</th>
                <th style={thStyle}>{t("reports.difference")}</th>
              </tr>
            </thead>
            <tbody>
              {cashSessionRows.map((r, i) => (
                <tr key={i}>
                  <td style={tdStyle}>{r.openedAt}</td>
                  <td style={tdStyle}>{r.userName}</td>
                  <td style={tdStyle}>{r.openingAmount.toFixed(0)}</td>
                  <td style={tdStyle}>{r.closedAt ?? t("reports.inProgress")}</td>
                  <td style={tdStyle}>{r.closingAmount != null ? r.closingAmount.toFixed(0) : "—"}</td>
                  <td style={tdStyle}>{r.expectedAmount != null ? r.expectedAmount.toFixed(0) : "—"}</td>
                  <td
                    style={{
                      ...tdStyle,
                      color: r.difference == null ? undefined : r.difference === 0 ? "#86efac" : "#f87171",
                    }}
                  >
                    {r.difference != null ? r.difference.toFixed(0) : "—"}
                  </td>
                </tr>
              ))}
              {cashSessionRows.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={7}>
                    {t("reports.noCashSessions")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {subTab === "service_orders" && serviceOrdersEnabled && (
        <>
          {serviceOrderReportError && <div style={{ color: "#f87171", marginTop: 16 }}>{serviceOrderReportError}</div>}
          <table style={{ ...tableStyle, marginTop: 24 }}>
            <thead>
              <tr>
                <th style={thStyle}>{t("reports.ticket")}</th>
                <th style={thStyle}>{t("reports.date")}</th>
                <th style={thStyle}>{t("reports.customer")}</th>
                <th style={thStyle}>{t("reports.total")}</th>
                <th style={thStyle}>{t("reports.status")}</th>
                <th style={thStyle}>{t("reports.reportColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {serviceOrders.map((order) => (
                <tr key={order.id}>
                  <td style={tdStyle}>{order.number}</td>
                  <td style={tdStyle}>{order.createdAt}</td>
                  <td style={tdStyle}>{customerName(order.customerId) ?? "—"}</td>
                  <td style={tdStyle}>{order.total.toFixed(0)}</td>
                  <td style={tdStyle}>{PAYMENT_STATUS_LABELS[order.paymentStatus] ?? order.paymentStatus}</td>
                  <td style={tdStyle}>
                    <button
                      style={{ ...secondaryButtonStyle, padding: "6px 12px" }}
                      disabled={generatingOrderId === order.id}
                      onClick={() => handleGenerateServiceOrderReport(order)}
                    >
                      {generatingOrderId === order.id ? t("reports.generating") : t("reports.report")}
                    </button>
                  </td>
                </tr>
              ))}
              {serviceOrders.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={6}>
                    {t("reports.noServiceOrders")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
