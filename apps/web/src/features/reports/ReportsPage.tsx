import {
  buildCashFlowReportExcel,
  buildCashFlowReportPdf,
  buildMarginsReportExcel,
  buildMarginsReportPdf,
  buildSalesReportExcel,
  buildSalesReportPdf,
  buildTaxReportExcel,
  buildTaxReportPdf,
} from "@gestion-boutique/reports";
import {
  getCashFlow,
  getMarginsSummary,
  getProductMarginsBreakdown,
  getSalesSummary,
  getSettings,
  getTaxCollected,
  getTopProducts,
  hasPermission,
  listStores,
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

type SubTab = "sales" | "margins" | "cashflow" | "tax";

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
  const [productMargins, setProductMargins] = useState<ProductMarginBreakdown[]>([]);
  const [cashFlow, setCashFlow] = useState<CashFlow | null>(null);
  const [projection, setProjection] = useState<CashFlowProjection | null>(null);
  const [taxEnabled, setTaxEnabled] = useState(false);
  const [taxSummary, setTaxSummary] = useState<TaxCollectedSummary | null>(null);

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
    const [sales, products, margins, productBreakdown, flow, proj, settings, tax] = await Promise.all([
      getSalesSummary(db, range, storeId),
      getTopProducts(db, range, 10, storeId),
      getMarginsSummary(db, range, storeId),
      getProductMarginsBreakdown(db, range, storeId),
      getCashFlow(db, range, storeId),
      projectCashFlow(db, { years, growthRate, storeId }),
      getSettings(db),
      getTaxCollected(db, range, storeId),
    ]);
    setSalesSummary(sales);
    setTopProducts(products);
    setMarginsSummary(margins);
    setProductMargins(productBreakdown);
    setCashFlow(flow);
    setProjection(proj);
    setTaxEnabled(settings?.taxEnabled ?? false);
    setTaxSummary(tax);
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

  const subTabs: { key: SubTab; label: string }[] = [{ key: "sales", label: "Ventes" }];
  if (canViewMargins) subTabs.push({ key: "margins", label: "Marges" });
  subTabs.push({ key: "cashflow", label: "Trésorerie" });
  if (taxEnabled) subTabs.push({ key: "tax", label: "TVA" });

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
        {canSwitchStore && multiStoreEnabled && stores.filter((s) => s.isActive).length > 1 && (
          <label>
            Boutique
            <select
              style={inputStyle}
              value={reportStoreFilter}
              onChange={(e) => setReportStoreFilter(e.target.value)}
            >
              <option value="">Toutes les boutiques</option>
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

          <strong style={{ marginTop: 24, display: "block" }}>
            Produits les plus rentables (analyse ABC)
          </strong>
          <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: "4px 0 12px" }}>
            Classement par marge (pas par chiffre d'affaires) : Classe A = les produits qui, ensemble,
            génèrent 80% de la marge totale — ceux à ne jamais laisser en rupture. Classe B = les 15%
            suivants. Classe C = le reste, contribution marginale.
          </p>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Produit</th>
                <th style={thStyle}>Qté vendue</th>
                <th style={thStyle}>Marge</th>
                <th style={thStyle}>Taux</th>
                <th style={thStyle}>Part cumulée</th>
                <th style={thStyle}>Classe</th>
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
                    Aucune vente sur cette période.
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

      {subTab === "tax" && taxEnabled && taxSummary && (
        <>
          <div style={{ display: "flex", gap: 16, marginTop: 24 }}>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>TVA nette collectée</span>
              <strong style={{ fontSize: 22 }}>{taxSummary.totalTaxCollected.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>TVA sur ventes</span>
              <strong style={{ fontSize: 22 }}>{taxSummary.salesTaxTotal.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>TVA remboursée</span>
              <strong style={{ fontSize: 22 }}>{taxSummary.refundsTaxTotal.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>CA taxable (TTC net)</span>
              <strong style={{ fontSize: 22 }}>{taxSummary.taxableRevenue.toFixed(0)}</strong>
            </div>
          </div>

          <div style={cardStyle}>
            <strong>TVA collectée par jour</strong>
            <BarChart data={taxSummary.byDay.map((d) => ({ label: d.date.slice(5), value: d.taxCollected }))} />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button style={secondaryButtonStyle} onClick={exportTaxPdf}>
              Export PDF
            </button>
            <button style={secondaryButtonStyle} onClick={exportTaxExcel}>
              Export Excel
            </button>
          </div>
        </>
      )}
    </main>
  );
}
