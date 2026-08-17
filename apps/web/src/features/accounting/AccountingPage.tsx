import {
  buildBalanceSheetReportExcel,
  buildBalanceSheetReportPdf,
  buildIncomeStatementReportExcel,
  buildIncomeStatementReportPdf,
  buildSyscohadaBalanceExcel,
  buildSyscohadaBalancePdf,
  buildSyscohadaJournalExcel,
  buildSyscohadaJournalPdf,
} from "@gestion-boutique/reports";
import {
  getBalanceGenerale,
  getBalanceSheet,
  getIncomeStatement,
  getJournalAchats,
  getJournalTresorerie,
  getJournalVentes,
  getSettings,
  type BalanceSheet,
  type IncomeStatement,
  type SyscohadaBalanceRow,
  type SyscohadaJournalLine,
} from "@gestion-boutique/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, pageStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";

type SubTab = "income" | "balance" | "syscohada";
type SyscohadaView = "ventes" | "achats" | "tresorerie" | "balance";

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

export function AccountingPage() {
  const db = useDatabase();
  const { t } = useTranslation();

  const [subTab, setSubTab] = useState<SubTab>("income");

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const [fromDate, setFromDate] = useState(isoDate(thirtyDaysAgo));
  const [toDate, setToDate] = useState(isoDate(new Date()));

  const [incomeStatement, setIncomeStatement] = useState<IncomeStatement | null>(null);
  const [balanceSheet, setBalanceSheet] = useState<BalanceSheet | null>(null);
  const [syscohadaEnabled, setSyscohadaEnabled] = useState(false);

  const [syscohadaView, setSyscohadaView] = useState<SyscohadaView>("ventes");
  const [syscohadaLines, setSyscohadaLines] = useState<SyscohadaJournalLine[]>([]);
  const [syscohadaBalance, setSyscohadaBalance] = useState<SyscohadaBalanceRow[]>([]);

  const range = { from: fromDate, to: toDate };

  const refresh = useCallback(async () => {
    const [income, balance, settings] = await Promise.all([
      getIncomeStatement(db, range),
      getBalanceSheet(db, isoDate(new Date())),
      getSettings(db),
    ]);
    setIncomeStatement(income);
    setBalanceSheet(balance);
    setSyscohadaEnabled(settings.enableSyscohada);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, fromDate, toDate]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshSyscohada = useCallback(async () => {
    if (syscohadaView === "balance") {
      setSyscohadaBalance(await getBalanceGenerale(db, range));
      return;
    }
    const fetcher =
      syscohadaView === "ventes" ? getJournalVentes : syscohadaView === "achats" ? getJournalAchats : getJournalTresorerie;
    setSyscohadaLines(await fetcher(db, range));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, fromDate, toDate, syscohadaView]);

  useEffect(() => {
    if (subTab === "syscohada" && syscohadaEnabled) refreshSyscohada();
  }, [subTab, syscohadaEnabled, refreshSyscohada]);

  const exportIncomePdf = () => {
    if (!incomeStatement) return;
    const blob = buildIncomeStatementReportPdf(incomeStatement);
    downloadBlob(blob, `compte-de-resultat-${fromDate}-${toDate}.pdf`);
  };

  const exportIncomeExcel = () => {
    if (!incomeStatement) return;
    const blob = buildIncomeStatementReportExcel(incomeStatement);
    downloadBlob(blob, `compte-de-resultat-${fromDate}-${toDate}.xlsx`);
  };

  const exportBalancePdf = () => {
    if (!balanceSheet) return;
    const blob = buildBalanceSheetReportPdf(balanceSheet);
    downloadBlob(blob, `bilan-${balanceSheet.asOfDate}.pdf`);
  };

  const exportBalanceExcel = () => {
    if (!balanceSheet) return;
    const blob = buildBalanceSheetReportExcel(balanceSheet);
    downloadBlob(blob, `bilan-${balanceSheet.asOfDate}.xlsx`);
  };

  const SYSCOHADA_TITLES: Record<Exclude<SyscohadaView, "balance">, string> = {
    ventes: t("accounting.titles.ventes"),
    achats: t("accounting.titles.achats"),
    tresorerie: t("accounting.titles.tresorerie"),
  };

  const exportSyscohadaPdf = () => {
    if (syscohadaView === "balance") {
      const blob = buildSyscohadaBalancePdf({ from: fromDate, to: toDate, rows: syscohadaBalance });
      downloadBlob(blob, `balance-generale-${fromDate}-${toDate}.pdf`);
      return;
    }
    const blob = buildSyscohadaJournalPdf({
      title: SYSCOHADA_TITLES[syscohadaView],
      from: fromDate,
      to: toDate,
      lines: syscohadaLines,
    });
    downloadBlob(blob, `journal-${syscohadaView}-${fromDate}-${toDate}.pdf`);
  };

  const exportSyscohadaExcel = () => {
    if (syscohadaView === "balance") {
      const blob = buildSyscohadaBalanceExcel({ from: fromDate, to: toDate, rows: syscohadaBalance });
      downloadBlob(blob, `balance-generale-${fromDate}-${toDate}.xlsx`);
      return;
    }
    const blob = buildSyscohadaJournalExcel({
      title: SYSCOHADA_TITLES[syscohadaView],
      from: fromDate,
      to: toDate,
      lines: syscohadaLines,
    });
    downloadBlob(blob, `journal-${syscohadaView}-${fromDate}-${toDate}.xlsx`);
  };

  const subTabs: { key: SubTab; label: string }[] = [
    { key: "income", label: t("accounting.tabs.income") },
    { key: "balance", label: t("accounting.tabs.balance") },
    ...(syscohadaEnabled ? [{ key: "syscohada" as const, label: t("accounting.tabs.syscohada") }] : []),
  ];

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1>{t("accounting.title")}</h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
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

      <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{t("accounting.hint")}</p>

      {subTab === "income" && (
        <>
          <div style={{ ...cardStyle, flexDirection: "row", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
            <label>
              {t("accounting.from")}
              <input
                style={inputStyle}
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </label>
            <label>
              {t("accounting.to")}
              <input style={inputStyle} type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </label>
          </div>

          {incomeStatement && (
            <>
              <div style={{ display: "flex", gap: 16, marginTop: 24, flexWrap: "wrap" }}>
                <div style={cardStyle}>
                  <span style={{ color: "var(--color-text-muted)" }}>{t("accounting.revenue")}</span>
                  <strong style={{ fontSize: 22 }}>{incomeStatement.revenue.toFixed(0)}</strong>
                </div>
                <div style={cardStyle}>
                  <span style={{ color: "var(--color-text-muted)" }}>{t("accounting.cogs")}</span>
                  <strong style={{ fontSize: 22 }}>{incomeStatement.cogs.toFixed(0)}</strong>
                </div>
                <div style={cardStyle}>
                  <span style={{ color: "var(--color-text-muted)" }}>{t("accounting.expenses")}</span>
                  <strong style={{ fontSize: 22 }}>{incomeStatement.expensesTotal.toFixed(0)}</strong>
                </div>
                <div style={cardStyle}>
                  <span style={{ color: "var(--color-text-muted)" }}>{t("accounting.netIncome")}</span>
                  <strong
                    style={{ fontSize: 22, color: incomeStatement.netIncome >= 0 ? "#86efac" : "#f87171" }}
                  >
                    {incomeStatement.netIncome.toFixed(0)}
                  </strong>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24, flexWrap: "wrap", gap: 8 }}>
                <strong>{t("accounting.expensesByCategory")}</strong>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button style={secondaryButtonStyle} onClick={exportIncomePdf}>
                    {t("accounting.exportPdf")}
                  </button>
                  <button style={secondaryButtonStyle} onClick={exportIncomeExcel}>
                    {t("accounting.exportExcel")}
                  </button>
                </div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>{t("accounting.category")}</th>
                      <th style={thStyle}>{t("accounting.amount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {incomeStatement.expensesByCategory.map((e) => (
                      <tr key={e.category}>
                        <td style={tdStyle}>{e.category}</td>
                        <td style={tdStyle}>{e.amount.toFixed(0)}</td>
                      </tr>
                    ))}
                    {incomeStatement.expensesByCategory.length === 0 && (
                      <tr>
                        <td style={tdStyle} colSpan={2}>
                          {t("accounting.noExpenses")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {subTab === "balance" && balanceSheet && (
        <>
          <div style={{ display: "flex", gap: 16, marginTop: 24, flexWrap: "wrap" }}>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("accounting.cash")}</span>
              <strong style={{ fontSize: 22 }}>{balanceSheet.cash.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("accounting.stockValue")}</span>
              <strong style={{ fontSize: 22 }}>{balanceSheet.stockValue.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("accounting.receivables")}</span>
              <strong style={{ fontSize: 22 }}>{balanceSheet.receivables.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("accounting.totalAssets")}</span>
              <strong style={{ fontSize: 22 }}>{balanceSheet.actifTotal.toFixed(0)}</strong>
            </div>
          </div>

          <div style={{ display: "flex", gap: 16, marginTop: 16, flexWrap: "wrap" }}>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("accounting.payables")}</span>
              <strong style={{ fontSize: 22 }}>{balanceSheet.payables.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("accounting.totalLiabilities")}</span>
              <strong style={{ fontSize: 22 }}>{balanceSheet.passifTotal.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>{t("accounting.equity")}</span>
              <strong style={{ fontSize: 22, color: balanceSheet.equity >= 0 ? "#86efac" : "#f87171" }}>
                {balanceSheet.equity.toFixed(0)}
              </strong>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button style={secondaryButtonStyle} onClick={exportBalancePdf}>
              {t("accounting.exportPdf")}
            </button>
            <button style={secondaryButtonStyle} onClick={exportBalanceExcel}>
              {t("accounting.exportExcel")}
            </button>
          </div>
        </>
      )}

      {subTab === "syscohada" && syscohadaEnabled && (
        <>
          <div
            style={{
              borderLeft: "3px solid #f59e0b",
              background: "rgba(245, 158, 11, 0.08)",
              padding: "10px 14px",
              borderRadius: 6,
              marginTop: 16,
              fontSize: 13,
              color: "var(--color-text)",
            }}
          >
            {t("accounting.syscohadaWarning")}
          </div>

          <div style={{ ...cardStyle, flexDirection: "row", flexWrap: "wrap", gap: 16, alignItems: "flex-end", marginTop: 16 }}>
            <label>
              {t("accounting.from")}
              <input
                style={inputStyle}
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </label>
            <label>
              {t("accounting.to")}
              <input style={inputStyle} type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </label>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {(
                [
                  { key: "ventes", label: t("accounting.views.ventes") },
                  { key: "achats", label: t("accounting.views.achats") },
                  { key: "tresorerie", label: t("accounting.views.tresorerie") },
                  { key: "balance", label: t("accounting.views.balance") },
                ] as { key: SyscohadaView; label: string }[]
              ).map((v) => (
                <button
                  key={v.key}
                  onClick={() => setSyscohadaView(v.key)}
                  style={{
                    ...secondaryButtonStyle,
                    background: syscohadaView === v.key ? "var(--gradient-accent)" : "transparent",
                    color: syscohadaView === v.key ? "#0f172a" : "var(--color-text)",
                    border: syscohadaView === v.key ? "none" : "1px solid var(--color-border)",
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button style={secondaryButtonStyle} onClick={exportSyscohadaPdf}>
                {t("accounting.exportPdf")}
              </button>
              <button style={secondaryButtonStyle} onClick={exportSyscohadaExcel}>
                {t("accounting.exportExcel")}
              </button>
            </div>
          </div>

          {syscohadaView !== "balance" ? (
            <table style={{ ...tableStyle, marginTop: 16 }}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("accounting.date")}</th>
                  <th style={thStyle}>{t("accounting.piece")}</th>
                  <th style={thStyle}>{t("accounting.account")}</th>
                  <th style={thStyle}>{t("accounting.label")}</th>
                  <th style={thStyle}>{t("accounting.narration")}</th>
                  <th style={thStyle}>{t("accounting.debit")}</th>
                  <th style={thStyle}>{t("accounting.credit")}</th>
                </tr>
              </thead>
              <tbody>
                {syscohadaLines.map((l, i) => (
                  <tr key={i}>
                    <td style={tdStyle}>{l.date}</td>
                    <td style={tdStyle}>{l.piece}</td>
                    <td style={tdStyle}>{l.compte}</td>
                    <td style={tdStyle}>{l.intitule}</td>
                    <td style={tdStyle}>{l.libelle}</td>
                    <td style={tdStyle}>{l.debit > 0 ? l.debit.toFixed(0) : ""}</td>
                    <td style={tdStyle}>{l.credit > 0 ? l.credit.toFixed(0) : ""}</td>
                  </tr>
                ))}
                {syscohadaLines.length === 0 && (
                  <tr>
                    <td style={tdStyle} colSpan={7}>
                      {t("accounting.noMovements")}
                    </td>
                  </tr>
                )}
              </tbody>
              {syscohadaLines.length > 0 && (
                <tfoot>
                  <tr>
                    <td style={tdStyle} colSpan={5}>
                      <strong>{t("accounting.total")}</strong>
                    </td>
                    <td style={tdStyle}>
                      <strong>{syscohadaLines.reduce((sum, l) => sum + l.debit, 0).toFixed(0)}</strong>
                    </td>
                    <td style={tdStyle}>
                      <strong>{syscohadaLines.reduce((sum, l) => sum + l.credit, 0).toFixed(0)}</strong>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          ) : (
            <table style={{ ...tableStyle, marginTop: 16 }}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("accounting.account")}</th>
                  <th style={thStyle}>{t("accounting.label")}</th>
                  <th style={thStyle}>{t("accounting.debit")}</th>
                  <th style={thStyle}>{t("accounting.credit")}</th>
                  <th style={thStyle}>{t("accounting.balanceColumn")}</th>
                </tr>
              </thead>
              <tbody>
                {syscohadaBalance.map((r) => (
                  <tr key={r.compte}>
                    <td style={tdStyle}>{r.compte}</td>
                    <td style={tdStyle}>{r.intitule}</td>
                    <td style={tdStyle}>{r.debit.toFixed(0)}</td>
                    <td style={tdStyle}>{r.credit.toFixed(0)}</td>
                    <td style={tdStyle}>{r.solde.toFixed(0)}</td>
                  </tr>
                ))}
                {syscohadaBalance.length === 0 && (
                  <tr>
                    <td style={tdStyle} colSpan={5}>
                      {t("accounting.noMovements")}
                    </td>
                  </tr>
                )}
              </tbody>
              {syscohadaBalance.length > 0 && (
                <tfoot>
                  <tr>
                    <td style={tdStyle} colSpan={2}>
                      <strong>{t("accounting.total")}</strong>
                    </td>
                    <td style={tdStyle}>
                      <strong>{syscohadaBalance.reduce((sum, r) => sum + r.debit, 0).toFixed(0)}</strong>
                    </td>
                    <td style={tdStyle}>
                      <strong>{syscohadaBalance.reduce((sum, r) => sum + r.credit, 0).toFixed(0)}</strong>
                    </td>
                    <td style={tdStyle} />
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </>
      )}
    </main>
  );
}
