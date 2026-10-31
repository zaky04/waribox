import {
  closeStockCount,
  getOpenStockCount,
  getStockCountLines,
  getStockCountReport,
  listAllVariants,
  listLocations,
  listProducts,
  listStockCounts,
  saveCountedQuantity,
  startStockCount,
  type CloseStockCountResult,
  type StockCountVariance,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { getLocationDisplayName } from "@gestion-boutique/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { amountStyle, cardStyle, inputStyle, pageStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { formatAmount, formatMoney } from "../../lib/format";
import { useApproval } from "../approval/ApprovalProvider";
import { useAuth } from "../auth/useAuth";

type Location = typeof schema.stockLocations.$inferSelect;
type StockCount = typeof schema.stockCounts.$inferSelect;
type CountLine = typeof schema.stockCountLines.$inferSelect;
type Product = typeof schema.products.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;

interface ReportView {
  count: StockCount;
  variances: StockCountVariance[];
  missingValue: number;
  surplusValue: number;
}

// Inventaire physique : comptage EN AVEUGLE (les quantités théoriques ne sont
// pas affichées pendant la saisie), puis clôture qui calcule l'écart valorisé
// et régularise le stock (avec l'approbation d'un responsable au-delà du plafond).
export function InventoryPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const { t } = useTranslation();
  const approval = useApproval();

  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [openCount, setOpenCount] = useState<StockCount | null>(null);
  const [lines, setLines] = useState<CountLine[]>([]);
  const [inputs, setInputs] = useState<Record<number, string>>({});
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [history, setHistory] = useState<StockCount[]>([]);
  const [report, setReport] = useState<ReportView | null>(null);
  const [search, setSearch] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBase = useCallback(async () => {
    const [locs, prods, vars] = await Promise.all([
      listLocations(db, currentStoreId ?? undefined),
      listProducts(db),
      listAllVariants(db),
    ]);
    setLocations(locs);
    setProducts(prods);
    setVariants(vars);
    setLocationId((prev) => prev || (locs[0] ? String(locs[0].id) : ""));
  }, [db, currentStoreId]);

  const loadCount = useCallback(async () => {
    if (!locationId) return;
    const lId = Number(locationId);
    const [open, past] = await Promise.all([getOpenStockCount(db, lId), listStockCounts(db, lId)]);
    setOpenCount(open ?? null);
    setHistory(past.filter((c) => c.status === "closed"));
    if (open) {
      const rows = await getStockCountLines(db, open.id);
      setLines(rows);
      setInputs(Object.fromEntries(rows.map((r) => [r.variantId, r.countedQuantity == null ? "" : String(r.countedQuantity)])));
    } else {
      setLines([]);
      setInputs({});
    }
  }, [db, locationId]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);
  useEffect(() => {
    void loadCount();
  }, [loadCount]);

  const productLabel = (variantId: number) => {
    const variant = variants.find((v) => v.id === variantId);
    const product = variant ? products.find((p) => p.id === variant.productId) : undefined;
    const attrs = variant?.attributes && variant.attributes !== "{}" ? ` (${variant.attributes})` : "";
    return `${product?.name ?? "?"}${attrs}`;
  };

  const visibleLines = useMemo(() => {
    const q = search.trim().toLowerCase();
    return lines
      .map((l) => ({ line: l, label: productLabel(l.variantId) }))
      .filter((x) => !q || x.label.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, search, products, variants]);

  const countedCount = lines.filter((l) => inputs[l.variantId] !== undefined && inputs[l.variantId] !== "").length;

  const handleStart = async () => {
    if (!user || !locationId) return;
    setError(null);
    setBusy(true);
    try {
      await startStockCount(db, { locationId: Number(locationId), storeId: currentStoreId ?? undefined, userId: user.id }, user.permissions);
      setReport(null);
      await loadCount();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("inventory.errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const saveLine = async (variantId: number, raw: string) => {
    if (!user || !openCount) return;
    try {
      await saveCountedQuantity(
        db,
        { countId: openCount.id, variantId, countedQuantity: raw === "" ? null : Number(raw) },
        user.permissions,
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("inventory.errors.generic"));
    }
  };

  const handleClose = async () => {
    if (!user || !openCount) return;
    setError(null);
    setBusy(true);
    try {
      // Enregistre toutes les saisies avant de clôturer (ne pas dépendre de la
      // perte de focus d'un champ : la dernière quantité tapée serait perdue).
      for (const line of lines) {
        const raw = inputs[line.variantId] ?? "";
        await saveCountedQuantity(db, { countId: openCount.id, variantId: line.variantId, countedQuantity: raw === "" ? null : Number(raw) }, user.permissions);
      }
      const result: CloseStockCountResult = await approval.run((a) =>
        closeStockCount(db, { countId: openCount.id, userId: user.id, note, approval: a }, user.permissions),
      );
      setNote("");
      setReport({ count: result.count, variances: result.variances, missingValue: result.missingValue, surplusValue: result.surplusValue });
      await loadCount();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("inventory.errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const openReport = async (countId: number) => {
    const r = await getStockCountReport(db, countId);
    setReport(r);
  };

  const varianceRows = report?.variances.filter((v) => v.difference !== 0) ?? [];

  return (
    <main style={pageStyle}>
      <h1>{t("inventory.title")}</h1>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("inventory.hint")}</p>

      <div style={cardStyle}>
        <label>
          {t("inventory.location")}
          <select style={inputStyle} value={locationId} onChange={(e) => { setLocationId(e.target.value); setReport(null); }} disabled={!!openCount}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {getLocationDisplayName(l.name)}
              </option>
            ))}
          </select>
        </label>
        {!openCount && (
          <button style={primaryButtonStyle} onClick={handleStart} disabled={busy || !locationId}>
            {t("inventory.start")}
          </button>
        )}
        {error && <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{error}</p>}
      </div>

      {openCount && (
        <div style={cardStyle}>
          <strong>{t("inventory.inProgress", { id: openCount.id })}</strong>
          <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
            {t("inventory.progress", { counted: countedCount, total: lines.length })} — {t("inventory.blindHint")}
          </p>
          <input style={inputStyle} placeholder={t("inventory.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="table-scroll" style={{ maxHeight: 420, overflowY: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("inventory.product")}</th>
                  <th style={thStyle}>{t("inventory.counted")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleLines.map(({ line, label }) => (
                  <tr key={line.variantId}>
                    <td style={tdStyle}>{label}</td>
                    <td style={tdStyle}>
                      <input
                        style={{ ...inputStyle, width: 110 }}
                        type="number"
                        step="any"
                        min={0}
                        value={inputs[line.variantId] ?? ""}
                        onChange={(e) => setInputs((prev) => ({ ...prev, [line.variantId]: e.target.value }))}
                        onBlur={(e) => void saveLine(line.variantId, e.target.value)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label>
            {t("inventory.note")}
            <input style={inputStyle} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button style={primaryButtonStyle} onClick={handleClose} disabled={busy || countedCount === 0}>
            {busy ? t("inventory.closing") : t("inventory.close")}
          </button>
          <p style={{ color: "var(--color-text-muted)", fontSize: 12.5, margin: 0 }}>{t("inventory.closeHint")}</p>
        </div>
      )}

      {report && (
        <div style={cardStyle}>
          <strong>{t("inventory.reportTitle", { id: report.count.id })}</strong>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
            <div>
              <div style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{t("inventory.missingValue")}</div>
              <strong style={{ ...amountStyle, fontSize: 20, color: report.missingValue > 0 ? "var(--color-danger)" : undefined }}>
                {formatMoney(report.missingValue)}
              </strong>
            </div>
            <div>
              <div style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{t("inventory.surplusValue")}</div>
              <strong style={{ ...amountStyle, fontSize: 20 }}>{formatMoney(report.surplusValue)}</strong>
            </div>
          </div>
          {varianceRows.length === 0 ? (
            <p style={{ margin: 0 }}>{t("inventory.noVariance")}</p>
          ) : (
            <div className="table-scroll">
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>{t("inventory.product")}</th>
                    <th style={thStyle}>{t("inventory.system")}</th>
                    <th style={thStyle}>{t("inventory.counted")}</th>
                    <th style={thStyle}>{t("inventory.difference")}</th>
                    <th style={thStyle}>{t("inventory.value")}</th>
                  </tr>
                </thead>
                <tbody>
                  {varianceRows.map((v) => (
                    <tr key={v.variantId}>
                      <td style={tdStyle}>{productLabel(v.variantId)}</td>
                      <td style={tdStyle}>{v.systemQuantity}</td>
                      <td style={tdStyle}>{v.countedQuantity}</td>
                      <td style={{ ...tdStyle, color: v.difference < 0 ? "var(--color-danger)" : "var(--color-success)" }}>
                        {v.difference > 0 ? "+" : ""}
                        {v.difference}
                      </td>
                      <td style={{ ...tdStyle, ...amountStyle }}>{formatAmount(v.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div style={cardStyle}>
          <strong>{t("inventory.history")}</strong>
          <div className="table-scroll">
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("inventory.number")}</th>
                  <th style={thStyle}>{t("inventory.closedAt")}</th>
                  <th style={thStyle} />
                </tr>
              </thead>
              <tbody>
                {history.map((c) => (
                  <tr key={c.id}>
                    <td style={tdStyle}>#{c.id}</td>
                    <td style={tdStyle}>{c.closedAt}</td>
                    <td style={tdStyle}>
                      <button style={{ ...primaryButtonStyle, padding: "4px 12px" }} onClick={() => void openReport(c.id)}>
                        {t("inventory.viewReport")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
