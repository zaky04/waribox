import {
  CONTROL_THRESHOLDS,
  getControlsReport,
  getSupplierPriceComparison,
  listUsers,
  verifyAuditChain,
  type AuditChainResult,
  type ControlFlag,
  type ControlsReport,
  type PriceComparisonRow,
} from "@gestion-boutique/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { amountStyle, badgeStyle, cardStyle, inputStyle, pageStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { formatAmount, formatMoney } from "../../lib/format";
import { useAuth } from "../auth/useAuth";

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Tableau de bord des contrôles de gestion : signaux à vérifier par employé et
// par fournisseur. Ce ne sont PAS des accusations — chaque signal est un point
// de départ pour vérifier (ticket, caméra, discussion), avec ses seuils affichés.
export function ControlsPage() {
  const db = useDatabase();
  const { currentStoreId } = useAuth();
  const { t } = useTranslation();

  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 29 * 86400000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [report, setReport] = useState<ControlsReport | null>(null);
  const [prices, setPrices] = useState<PriceComparisonRow[]>([]);
  const [userNames, setUserNames] = useState<Map<number, string>>(new Map());
  const [chain, setChain] = useState<AuditChainResult | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    const [r, p, users] = await Promise.all([
      getControlsReport(db, { from, to }, currentStoreId ?? undefined),
      getSupplierPriceComparison(db),
      listUsers(db),
    ]);
    setReport(r);
    setPrices(p.filter((row) => row.suppliers.length >= 2));
    setUserNames(new Map(users.map((u) => [u.id, u.fullName] as const)));
  }, [db, from, to, currentStoreId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flagText = (flag: ControlFlag) => {
    const params: Record<string, string | number> = { value: Math.round(flag.value * 10) / 10, amount: formatAmount(flag.value), threshold: 0 };
    if (flag.code === "refund_rate") params.threshold = CONTROL_THRESHOLDS.refundRatePercent;
    if (flag.code === "loss_rate") params.threshold = CONTROL_THRESHOLDS.lossRatePercent;
    if (flag.code === "manual_entries") params.threshold = CONTROL_THRESHOLDS.manualEntryCount;
    if (flag.code === "failed_approvals") params.threshold = CONTROL_THRESHOLDS.failedApprovals;
    if (flag.code === "price_changes") params.threshold = CONTROL_THRESHOLDS.priceChanges;
    if (flag.code === "expense_edits") params.threshold = CONTROL_THRESHOLDS.expenseEdits;
    return t(`controls.flags.${flag.code}`, params);
  };

  const nameOf = (id: number | null) => (id == null ? "—" : (userNames.get(id) ?? `#${id}`));

  const verify = async () => {
    setChecking(true);
    try {
      setChain(await verifyAuditChain(db));
    } finally {
      setChecking(false);
    }
  };

  const flaggedEmployees = report?.employees.filter((e) => e.flags.length > 0) ?? [];
  const flaggedSuppliers = report?.suppliers.filter((s) => s.flags.length > 0) ?? [];
  const totalFlags = flaggedEmployees.reduce((n, e) => n + e.flags.length, 0) + flaggedSuppliers.reduce((n, s) => n + s.flags.length, 0);

  return (
    <main style={pageStyle}>
      <h1>{t("controls.title")}</h1>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("controls.hint")}</p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <label>
          {t("controls.from")}
          <input style={inputStyle} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t("controls.to")}
          <input style={inputStyle} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      <div style={{ ...cardStyle, borderColor: totalFlags > 0 ? "var(--color-warning)" : undefined }}>
        <strong>{t("controls.signalsTitle", { count: totalFlags })}</strong>
        {totalFlags === 0 ? (
          <p style={{ margin: 0, color: "var(--color-success)" }}>{t("controls.noSignal")}</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            {flaggedEmployees.flatMap((e) =>
              e.flags.map((f) => (
                <li key={`${e.userId}-${f.code}`} style={{ color: f.severity === "danger" ? "var(--color-danger)" : "var(--color-warning)" }}>
                  <strong>{e.name}</strong> — {flagText(f)}
                </li>
              )),
            )}
            {flaggedSuppliers.flatMap((s) =>
              s.flags.map((f) => (
                <li key={`s${s.supplierId}-${f.code}`} style={{ color: f.severity === "danger" ? "var(--color-danger)" : "var(--color-warning)" }}>
                  <strong>{s.name}</strong> — {flagText(f)}
                </li>
              )),
            )}
          </ul>
        )}
      </div>

      <div style={cardStyle}>
        <strong>{t("controls.employees")}</strong>
        <div className="table-scroll">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t("controls.col.employee")}</th>
                <th style={thStyle}>{t("controls.col.sales")}</th>
                <th style={thStyle}>{t("controls.col.refundsProcessed")}</th>
                <th style={thStyle}>{t("controls.col.refundRate")}</th>
                <th style={thStyle}>{t("controls.col.credit")}</th>
                <th style={thStyle}>{t("controls.col.losses")}</th>
                <th style={thStyle}>{t("controls.col.manualEntries")}</th>
                <th style={thStyle}>{t("controls.col.cashVariance")}</th>
                <th style={thStyle}>{t("controls.col.other")}</th>
              </tr>
            </thead>
            <tbody>
              {report?.employees.map((e) => (
                <tr key={e.userId}>
                  <td style={tdStyle}>
                    {e.name}{" "}
                    {e.flags.length > 0 && <span style={badgeStyle(e.flags.some((f) => f.severity === "danger") ? "danger" : "warning")}>{e.flags.length}</span>}
                  </td>
                  <td style={{ ...tdStyle, ...amountStyle }}>
                    {e.salesCount} · {formatAmount(e.salesTotal)}
                  </td>
                  <td style={{ ...tdStyle, ...amountStyle }}>
                    {e.refundsProcessed} · {formatAmount(e.refundsProcessedTotal)}
                  </td>
                  <td style={tdStyle}>{e.refundRate.toFixed(1)} %</td>
                  <td style={{ ...tdStyle, ...amountStyle }}>
                    {e.creditCount} · {formatAmount(e.creditTotal)}
                  </td>
                  <td style={{ ...tdStyle, ...amountStyle }}>
                    {e.lossCount} · {formatAmount(e.lossValue)}
                  </td>
                  <td style={{ ...tdStyle, ...amountStyle }}>
                    {e.manualEntryCount} · {formatAmount(e.manualEntryValue)}
                  </td>
                  <td style={{ ...tdStyle, ...amountStyle, color: e.cashVariance < 0 ? "var(--color-danger)" : undefined }}>
                    {e.cashSessions > 0 ? `${e.cashVariance > 0 ? "+" : ""}${formatAmount(e.cashVariance)}` : "—"}
                  </td>
                  <td style={tdStyle}>
                    {t("controls.other", { prices: e.priceChanges, expenses: e.expenseEdits, failed: e.failedApprovals, approvals: e.approvalsGiven })}
                  </td>
                </tr>
              ))}
              {report && report.employees.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={9}>
                    {t("controls.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p style={{ color: "var(--color-text-muted)", fontSize: 12.5, margin: 0 }}>
          {t("controls.thresholds", {
            refund: CONTROL_THRESHOLDS.refundRatePercent,
            loss: CONTROL_THRESHOLDS.lossRatePercent,
            entries: CONTROL_THRESHOLDS.manualEntryCount,
          })}
        </p>
      </div>

      <div style={cardStyle}>
        <strong>{t("controls.cashTitle")}</strong>
        <div className="table-scroll">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t("controls.col.date")}</th>
                <th style={thStyle}>{t("controls.col.employee")}</th>
                <th style={thStyle}>{t("controls.col.expected")}</th>
                <th style={thStyle}>{t("controls.col.counted")}</th>
                <th style={thStyle}>{t("controls.col.difference")}</th>
              </tr>
            </thead>
            <tbody>
              {report?.cashVariances.map((c) => (
                <tr key={c.sessionId}>
                  <td style={tdStyle}>{c.closedAt}</td>
                  <td style={tdStyle}>{nameOf(c.userId)}</td>
                  <td style={{ ...tdStyle, ...amountStyle }}>{formatAmount(c.expected)}</td>
                  <td style={{ ...tdStyle, ...amountStyle }}>{formatAmount(c.counted)}</td>
                  <td style={{ ...tdStyle, ...amountStyle, color: c.alert ? "var(--color-danger)" : undefined, fontWeight: c.alert ? 700 : undefined }}>
                    {c.difference > 0 ? "+" : ""}
                    {formatAmount(c.difference)}
                  </td>
                </tr>
              ))}
              {report && report.cashVariances.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={5}>
                    {t("controls.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {report && report.stockCounts.length > 0 && (
        <div style={cardStyle}>
          <strong>{t("controls.stockCountsTitle")}</strong>
          <div className="table-scroll">
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("controls.col.date")}</th>
                  <th style={thStyle}>{t("controls.col.employee")}</th>
                  <th style={thStyle}>{t("controls.col.missing")}</th>
                  <th style={thStyle}>{t("controls.col.surplus")}</th>
                </tr>
              </thead>
              <tbody>
                {report.stockCounts.map((c) => (
                  <tr key={c.countId}>
                    <td style={tdStyle}>{c.closedAt}</td>
                    <td style={tdStyle}>{nameOf(c.closedBy)}</td>
                    <td style={{ ...tdStyle, ...amountStyle, color: c.missingValue > 0 ? "var(--color-danger)" : undefined }}>{formatMoney(c.missingValue)}</td>
                    <td style={{ ...tdStyle, ...amountStyle }}>{formatMoney(c.surplusValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={cardStyle}>
        <strong>{t("controls.suppliersTitle")}</strong>
        <div className="table-scroll">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t("controls.col.supplier")}</th>
                <th style={thStyle}>{t("controls.col.purchases")}</th>
                <th style={thStyle}>{t("controls.col.priceAlerts")}</th>
                <th style={thStyle}>{t("controls.col.shortfall")}</th>
                <th style={thStyle}>{t("controls.col.awaiting")}</th>
                <th style={thStyle}>{t("controls.col.debt")}</th>
              </tr>
            </thead>
            <tbody>
              {report?.suppliers.map((s) => (
                <tr key={s.supplierId}>
                  <td style={tdStyle}>
                    {s.name}{" "}
                    {s.flags.length > 0 && <span style={badgeStyle(s.flags.some((f) => f.severity === "danger") ? "danger" : "warning")}>{s.flags.length}</span>}
                  </td>
                  <td style={{ ...tdStyle, ...amountStyle }}>
                    {s.purchasesCount} · {formatAmount(s.purchasesTotal)}
                  </td>
                  <td style={tdStyle}>{s.priceAlerts}</td>
                  <td style={{ ...tdStyle, ...amountStyle, color: s.shortfallValue > 0 ? "var(--color-danger)" : undefined }}>{formatAmount(s.shortfallValue)}</td>
                  <td style={tdStyle}>{s.awaitingReceipt}</td>
                  <td style={{ ...tdStyle, ...amountStyle }}>{formatAmount(s.openDebt)}</td>
                </tr>
              ))}
              {report && report.suppliers.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={6}>
                    {t("controls.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {prices.length > 0 && (
          <>
            <strong style={{ fontSize: 14 }}>{t("controls.priceComparison")}</strong>
            <div className="table-scroll">
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>{t("controls.col.product")}</th>
                    <th style={thStyle}>{t("controls.col.supplierPrices")}</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.map((row) => (
                    <tr key={row.variantId}>
                      <td style={tdStyle}>{row.productName}</td>
                      <td style={tdStyle}>
                        {row.suppliers.map((s) => (
                          <div key={s.supplierId} style={{ fontWeight: s.supplierId === row.cheapestSupplierId ? 700 : undefined }}>
                            {s.name} : {formatMoney(s.lastCost)} <span style={{ color: "var(--color-text-muted)" }}>({t("controls.avg")} {formatAmount(s.avgCost)}, ×{s.count})</span>
                            {s.supplierId === row.cheapestSupplierId ? " ✓" : ""}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div style={cardStyle}>
        <strong>{t("controls.eventsTitle")}</strong>
        <div className="table-scroll">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t("controls.col.date")}</th>
                <th style={thStyle}>{t("controls.col.kind")}</th>
                <th style={thStyle}>{t("controls.col.employee")}</th>
                <th style={thStyle}>{t("controls.col.amount")}</th>
                <th style={thStyle}>{t("controls.col.detail")}</th>
              </tr>
            </thead>
            <tbody>
              {report?.events.map((ev, i) => (
                <tr key={i}>
                  <td style={tdStyle}>{ev.at}</td>
                  <td style={tdStyle}>{t(`controls.eventKinds.${ev.kind}`)}</td>
                  <td style={tdStyle}>{nameOf(ev.userId)}</td>
                  <td style={{ ...tdStyle, ...amountStyle }}>{formatAmount(ev.amount)}</td>
                  <td style={tdStyle}>{ev.detail}</td>
                </tr>
              ))}
              {report && report.events.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={5}>
                    {t("controls.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={cardStyle}>
        <strong>{t("controls.integrityTitle")}</strong>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("controls.integrityHint")}</p>
        <button style={{ ...primaryButtonStyle, alignSelf: "flex-start" }} onClick={verify} disabled={checking}>
          {checking ? t("controls.integrityChecking") : t("controls.integrityCheck")}
        </button>
        {chain && (
          <p style={{ margin: 0, color: chain.ok ? "var(--color-success)" : "var(--color-danger)", fontWeight: 600 }}>
            {chain.ok
              ? t("controls.integrityOk", { count: chain.checked, legacy: chain.legacyRows })
              : t("controls.integrityBroken", { id: chain.brokenAtId, reason: t(`controls.integrityReasons.${chain.reason}`) })}
          </p>
        )}
        {chain?.ok && chain.headHash && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--color-text-muted)", wordBreak: "break-all" }}>
            {t("controls.integrityHead")} <code>{chain.headHash}</code>
          </p>
        )}
      </div>
    </main>
  );
}
