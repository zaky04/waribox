import {
  CONTROL_THRESHOLDS,
  buildDailySummaryText,
  getControlsReport,
  getDailySummary,
  getVerificationSample,
  getSettings,
  getSupplierPriceComparison,
  listUsers,
  verifyAuditChain,
  type AuditChainResult,
  type ControlFlag,
  type ControlsReport,
  type PriceComparisonRow,
  type VerificationSample,
} from "@gestion-boutique/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { amountStyle, badgeStyle, cardStyle, inputStyle, pageStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { formatAmount, formatMoney } from "../../lib/format";
import { buildWhatsAppLink } from "../../lib/whatsapp";
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
  // Seuils d'alerte réglés dans Configuration → Contrôles de gestion.
  const [th, setTh] = useState({ refund: 5, loss: 2, discount: 5, staleDays: 30 });
  const [shop, setShop] = useState<{ phone: string; countryCode: string | null; name: string | null }>({ phone: "", countryCode: null, name: null });
  const [summaryDate, setSummaryDate] = useState(() => isoDay(new Date()));
  const [summaryText, setSummaryText] = useState("");
  const [copied, setCopied] = useState(false);
  const [sample, setSample] = useState<VerificationSample | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    const [r, p, users, settings] = await Promise.all([
      getControlsReport(db, { from, to }, currentStoreId ?? undefined),
      getSupplierPriceComparison(db),
      listUsers(db),
      getSettings(db),
    ]);
    setTh({ refund: settings.alertRefundPercent, loss: settings.alertLossPercent, discount: settings.alertDiscountPercent, staleDays: settings.staleTicketDays });
    setShop({ phone: settings.lowStockAlertPhone ?? "", countryCode: settings.whatsappCountryCode ?? null, name: settings.businessName ?? null });
    setReport(r);
    setPrices(p.filter((row) => row.suppliers.length >= 2));
    setUserNames(new Map(users.map((u) => [u.id, u.fullName] as const)));
  }, [db, from, to, currentStoreId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flagText = (flag: ControlFlag) => {
    const params: Record<string, string | number> = { value: Math.round(flag.value * 10) / 10, amount: formatAmount(flag.value), threshold: 0 };
    if (flag.code === "refund_rate") params.threshold = th.refund;
    if (flag.code === "loss_rate") params.threshold = th.loss;
    if (flag.code === "discount_rate") params.threshold = th.discount;
    if (flag.code === "stale_tickets") params.threshold = th.staleDays;
    if (flag.code === "manual_entries") params.threshold = CONTROL_THRESHOLDS.manualEntryCount;
    if (flag.code === "failed_approvals") params.threshold = CONTROL_THRESHOLDS.failedApprovals;
    if (flag.code === "price_changes") params.threshold = CONTROL_THRESHOLDS.priceChanges;
    if (flag.code === "expense_edits") params.threshold = CONTROL_THRESHOLDS.expenseEdits;
    return t(`controls.flags.${flag.code}`, params);
  };

  const nameOf = (id: number | null) => (id == null ? "—" : (userNames.get(id) ?? `#${id}`));

  const generateSummary = async () => {
    const summary = await getDailySummary(db, summaryDate, currentStoreId ?? undefined);
    setSummaryText(buildDailySummaryText(summary, shop.name));
    setCopied(false);
  };

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryText);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const drawSample = async () => {
    setSample(await getVerificationSample(db, { days: 7, count: 5, storeId: currentStoreId ?? undefined }));
  };

  const verify = async () => {
    setChecking(true);
    try {
      setChain(await verifyAuditChain(db));
    } finally {
      setChecking(false);
    }
  };

  const alerts = report?.alerts ?? [];
  const totalFlags = alerts.length;

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

      <div style={{ ...cardStyle, borderColor: alerts.some((a) => a.severity === "danger") ? "var(--color-danger)" : totalFlags > 0 ? "var(--color-warning)" : undefined }}>
        <strong>{t("controls.alertsTitle", { count: totalFlags })}</strong>
        {totalFlags === 0 ? (
          <p style={{ margin: 0, color: "var(--color-success)" }}>{t("controls.alertsNone")}</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            {alerts.map((a) => (
              <li key={`${a.subject}-${a.id}-${a.code}`} style={{ color: a.severity === "danger" ? "var(--color-danger)" : "var(--color-warning)" }}>
                {a.name && <strong>{a.name} — </strong>}
                {flagText({ code: a.code, severity: a.severity, value: a.value })}
              </li>
            ))}
          </ul>
        )}
      </div>

      {report && (report.staleTickets.length > 0 || report.unpaidPickups.length > 0 || report.numberGaps.length > 0) && (
        <div style={cardStyle}>
          <strong>{t("controls.ticketsTitle")}</strong>
          {report.staleTickets.length > 0 && (
            <>
              <span style={{ fontSize: 13 }}>{t("controls.staleTitle")}</span>
              <div className="table-scroll">
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>{t("controls.col.ticket")}</th>
                      <th style={thStyle}>{t("controls.col.readyItems")}</th>
                      <th style={thStyle}>{t("controls.col.value")}</th>
                      <th style={thStyle}>{t("controls.col.age")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.staleTickets.map((x) => (
                      <tr key={x.number}>
                        <td style={tdStyle}>{x.number}</td>
                        <td style={tdStyle}>{x.readyItems}</td>
                        <td style={{ ...tdStyle, ...amountStyle }}>{formatAmount(x.value)}</td>
                        <td style={tdStyle}>{x.ageDays}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {report.unpaidPickups.length > 0 && (
            <>
              <span style={{ fontSize: 13 }}>{t("controls.unpaidTitle")}</span>
              <div className="table-scroll">
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>{t("controls.col.ticket")}</th>
                      <th style={thStyle}>{t("controls.col.customer")}</th>
                      <th style={thStyle}>{t("controls.col.remaining")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.unpaidPickups.map((x) => (
                      <tr key={x.number}>
                        <td style={tdStyle}>{x.number}</td>
                        <td style={tdStyle}>{x.customerName}</td>
                        <td style={{ ...tdStyle, ...amountStyle, color: "var(--color-danger)" }}>{formatAmount(x.remaining)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {report.numberGaps.length > 0 && (
            <>
              <span style={{ fontSize: 13 }}>{t("controls.gapsTitle")}</span>
              {report.numberGaps.map((g) => (
                <p key={g.kind} style={{ margin: 0, fontSize: 13 }}>
                  <strong>{t(`controls.gapKinds.${g.kind}`)} :</strong> {g.missing.join(", ")}
                </p>
              ))}
            </>
          )}
        </div>
      )}

      <div style={cardStyle}>
        <strong>{t("controls.summary.title")}</strong>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("controls.summary.hint")}</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <label>
            {t("controls.summary.date")}
            <input style={inputStyle} type="date" value={summaryDate} onChange={(e) => setSummaryDate(e.target.value)} />
          </label>
          <button style={primaryButtonStyle} onClick={generateSummary}>
            {t("controls.summary.generate")}
          </button>
        </div>
        {summaryText && (
          <>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: 13 }}>{summaryText}</pre>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {shop.phone ? (
                <a
                  href={buildWhatsAppLink(shop.phone, shop.countryCode, summaryText)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...primaryButtonStyle, textDecoration: "none", display: "inline-block" }}
                >
                  {t("controls.summary.send")}
                </a>
              ) : (
                <span style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{t("controls.summary.noPhone")}</span>
              )}
              <button
                style={{ ...primaryButtonStyle, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                onClick={copySummary}
              >
                {copied ? t("controls.summary.copied") : t("controls.summary.copy")}
              </button>
            </div>
          </>
        )}
      </div>

      <div style={cardStyle}>
        <strong>{t("controls.verify.title")}</strong>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("controls.verify.hint")}</p>
        <button style={{ ...primaryButtonStyle, alignSelf: "flex-start" }} onClick={drawSample}>
          {t("controls.verify.draw")}
        </button>
        {sample && (
          <>
            <p style={{ margin: 0, fontSize: 13, color: sample.anonymousPercent >= 50 ? "var(--color-warning)" : "var(--color-text-muted)" }}>
              {t("controls.verify.anonymous", { percent: sample.anonymousPercent })}
            </p>
            {sample.items.length === 0 ? (
              <p style={{ margin: 0 }}>{t("controls.verify.empty")}</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}>
                {sample.items.map((it) => (
                  <li key={it.number}>
                    <strong>{it.number}</strong> — {it.customerName} — {formatMoney(it.total)} ({it.at.slice(0, 10)}){" "}
                    <a
                      href={buildWhatsAppLink(
                        it.phone,
                        shop.countryCode,
                        t("whatsapp.verifyMessage", {
                          name: it.customerName,
                          kind: t(`controls.verify.kinds.${it.kind}`),
                          number: it.number,
                          date: it.at.slice(0, 10),
                          amount: formatAmount(it.total),
                        }),
                      )}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("controls.verify.ask")}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div style={cardStyle}>
        <strong>{t("controls.employees")}</strong>
        <div className="table-scroll">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t("controls.col.employee")}</th>
                <th style={thStyle}>{t("controls.col.risk")}</th>
                <th style={thStyle}>{t("controls.col.sales")}</th>
                <th style={thStyle}>{t("controls.col.refundsProcessed")}</th>
                <th style={thStyle}>{t("controls.col.refundRate")}</th>
                <th style={thStyle}>{t("controls.col.discount")}</th>
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
                  <td style={tdStyle}>
                    <span style={badgeStyle(e.riskLevel === "high" ? "danger" : e.riskLevel === "medium" ? "warning" : "ok")}>
                      {e.riskScore} · {t(`controls.riskLevels.${e.riskLevel}`)}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, ...amountStyle }}>
                    {e.salesCount} · {formatAmount(e.salesTotal)}
                  </td>
                  <td style={{ ...tdStyle, ...amountStyle }}>
                    {e.refundsProcessed} · {formatAmount(e.refundsProcessedTotal)}
                  </td>
                  <td style={tdStyle}>{e.refundRate.toFixed(1)} %</td>
                  <td style={{ ...tdStyle, ...amountStyle }}>
                    {e.unauthorizedDiscountTotal > 0 ? `${formatAmount(e.unauthorizedDiscountTotal)} (${e.discountRate.toFixed(1)} %)` : "—"}
                  </td>
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
                    <br />
                    {t("controls.extra", { points: Math.round(e.pointsAdjusted), rejected: e.approvalsRejected })}
                  </td>
                </tr>
              ))}
              {report && report.employees.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={11}>
                    {t("controls.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p style={{ color: "var(--color-text-muted)", fontSize: 12.5, margin: 0 }}>
          {t("controls.thresholds", {
            refund: th.refund,
            loss: th.loss,
            entries: CONTROL_THRESHOLDS.manualEntryCount,
          })}
        </p>
        <p style={{ color: "var(--color-text-muted)", fontSize: 12.5, margin: 0 }}>{t("controls.riskHint")}</p>
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
