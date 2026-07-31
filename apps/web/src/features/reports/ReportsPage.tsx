import {
  buildCashFlowReportExcel,
  buildCashFlowReportPdf,
  buildMarginsReportExcel,
  buildMarginsReportPdf,
  buildSalesReportExcel,
  buildSalesReportPdf,
} from "@gestion-boutique/reports";
import {
  getCashFlow,
  getMarginsSummary,
  getSalesSummary,
  getTopProducts,
  hasPermission,
  projectCashFlow,
  type CashFlow,
  type CashFlowProjection,
  type MarginsSummary,
  type SalesSummary,
  type TopProduct,
} from "@gestion-boutique/core";
import { useCallback, useEffect, useState } from "react";
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

type SubTab = "sales" | "margins" | "cashflow";

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
  const { user } = useAuth();
  const canViewMargins = user ? hasPermission(user.permissions, "view_margins") : false;

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
  const [cashFlow, setCashFlow] = useState<CashFlow | null>(null);
  const [projection, setProjection] = useState<CashFlowProjection | null>(null);

  const range = { from: fromDate, to: toDate };

  const refresh = useCallback(async () => {
    const [sales, products, margins, flow, proj] = await Promise.all([
      getSalesSummary(db, range),
      getTopProducts(db, range),
      getMarginsSummary(db, range),
      getCashFlow(db, range),
      projectCashFlow(db, { years, growthRate }),
    ]);
    setSalesSummary(sales);
    setTopProducts(products);
    setMarginsSummary(margins);
    setCashFlow(flow);
    setProjection(proj);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, fromDate, toDate, years, growthRate]);

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
    const blob = buildMarginsReportPdf({ from: fromDate, to: toDate, ...marginsSummary });
    downloadBlob(blob, `rapport-marges-${fromDate}-${toDate}.pdf`);
  };

  const exportMarginsExcel = () => {
    if (!marginsSummary) return;
    const blob = buildMarginsReportExcel({ from: fromDate, to: toDate, ...marginsSummary });
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

  const subTabs: { key: SubTab; label: string }[] = [{ key: "sales", label: "Ventes" }];
  if (canViewMargins) subTabs.push({ key: "margins", label: "Marges" });
  subTabs.push({ key: "cashflow", label: "Trésorerie" });

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Rapports</h1>
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
          Du
          <input
            style={inputStyle}
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </label>
        <label>
          Au
          <input style={inputStyle} type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
      </div>

      {subTab === "sales" && salesSummary && (
        <>
          <div style={{ display: "flex", gap: 16, marginTop: 24 }}>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>CA total</span>
              <strong style={{ fontSize: 22 }}>{salesSummary.totalRevenue.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>Ventes</span>
              <strong style={{ fontSize: 22 }}>{salesSummary.saleCount}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>Panier moyen</span>
              <strong style={{ fontSize: 22 }}>{salesSummary.averageBasket.toFixed(0)}</strong>
            </div>
          </div>

          <div style={cardStyle}>
            <strong>CA par jour</strong>
            <BarChart data={salesSummary.byDay.map((d) => ({ label: d.date.slice(5), value: d.total }))} />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24 }}>
            <strong>Produits les plus vendus</strong>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={secondaryButtonStyle} onClick={exportSalesPdf}>
                Export PDF
              </button>
              <button style={secondaryButtonStyle} onClick={exportSalesExcel}>
                Export Excel
              </button>
            </div>
          </div>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Produit</th>
                <th style={thStyle}>Quantité</th>
                <th style={thStyle}>Revenu</th>
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
                    Aucune vente sur cette période.
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
              <span style={{ color: "var(--color-text-muted)" }}>Revenu</span>
              <strong style={{ fontSize: 22 }}>{marginsSummary.revenue.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>Coût</span>
              <strong style={{ fontSize: 22 }}>{marginsSummary.cost.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>Marge</span>
              <strong style={{ fontSize: 22, color: marginsSummary.margin >= 0 ? "#86efac" : "#f87171" }}>
                {marginsSummary.margin.toFixed(0)} ({marginsSummary.marginRate.toFixed(1)}%)
              </strong>
            </div>
          </div>

          <div style={cardStyle}>
            <strong>Marge par jour</strong>
            <BarChart data={marginsSummary.byDay.map((d) => ({ label: d.date.slice(5), value: d.margin }))} />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button style={secondaryButtonStyle} onClick={exportMarginsPdf}>
              Export PDF
            </button>
            <button style={secondaryButtonStyle} onClick={exportMarginsExcel}>
              Export Excel
            </button>
          </div>
        </>
      )}

      {subTab === "cashflow" && cashFlow && (
        <>
          <div style={cardStyle}>
            <strong>Flux de trésorerie mensuel (historique)</strong>
            <LineChart data={cashFlow.byMonth.map((m) => ({ label: m.month.slice(5), value: m.net }))} />
          </div>

          <div style={{ ...cardStyle, flexDirection: "row", gap: 16, alignItems: "flex-end" }}>
            <label>
              Années de projection
              <select style={inputStyle} value={years} onChange={(e) => setYears(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Taux de croissance annuel (%)
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
                <strong>Projection de trésorerie</strong>
                <BarChart
                  data={projection.byYear.map((y) => ({ label: `An ${y.year}`, value: y.projectedNet }))}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                <button style={secondaryButtonStyle} onClick={exportCashFlowPdf}>
                  Export PDF
                </button>
                <button style={secondaryButtonStyle} onClick={exportCashFlowExcel}>
                  Export Excel
                </button>
              </div>

              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Année</th>
                    <th style={thStyle}>Entrées projetées</th>
                    <th style={thStyle}>Sorties projetées</th>
                    <th style={thStyle}>Net</th>
                    <th style={thStyle}>Cumulé</th>
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
    </main>
  );
}
