import {
  buildBalanceSheetReportExcel,
  buildBalanceSheetReportPdf,
  buildIncomeStatementReportExcel,
  buildIncomeStatementReportPdf,
} from "@gestion-boutique/reports";
import { getBalanceSheet, getIncomeStatement, type BalanceSheet, type IncomeStatement } from "@gestion-boutique/core";
import { useCallback, useEffect, useState } from "react";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, pageStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";

type SubTab = "income" | "balance";

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

  const [subTab, setSubTab] = useState<SubTab>("income");

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const [fromDate, setFromDate] = useState(isoDate(thirtyDaysAgo));
  const [toDate, setToDate] = useState(isoDate(new Date()));

  const [incomeStatement, setIncomeStatement] = useState<IncomeStatement | null>(null);
  const [balanceSheet, setBalanceSheet] = useState<BalanceSheet | null>(null);

  const range = { from: fromDate, to: toDate };

  const refresh = useCallback(async () => {
    const [income, balance] = await Promise.all([
      getIncomeStatement(db, range),
      getBalanceSheet(db, isoDate(new Date())),
    ]);
    setIncomeStatement(income);
    setBalanceSheet(balance);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, fromDate, toDate]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  const subTabs: { key: SubTab; label: string }[] = [
    { key: "income", label: "Compte de résultat" },
    { key: "balance", label: "Bilan" },
  ];

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Comptabilité</h1>
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

      <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
        Vue comptable simplifiée à usage de gestion interne — ne remplace pas un bilan établi par un
        expert-comptable.
      </p>

      {subTab === "income" && (
        <>
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

          {incomeStatement && (
            <>
              <div style={{ display: "flex", gap: 16, marginTop: 24, flexWrap: "wrap" }}>
                <div style={cardStyle}>
                  <span style={{ color: "var(--color-text-muted)" }}>CA total</span>
                  <strong style={{ fontSize: 22 }}>{incomeStatement.revenue.toFixed(0)}</strong>
                </div>
                <div style={cardStyle}>
                  <span style={{ color: "var(--color-text-muted)" }}>Coût des ventes</span>
                  <strong style={{ fontSize: 22 }}>{incomeStatement.cogs.toFixed(0)}</strong>
                </div>
                <div style={cardStyle}>
                  <span style={{ color: "var(--color-text-muted)" }}>Charges</span>
                  <strong style={{ fontSize: 22 }}>{incomeStatement.expensesTotal.toFixed(0)}</strong>
                </div>
                <div style={cardStyle}>
                  <span style={{ color: "var(--color-text-muted)" }}>Résultat net</span>
                  <strong
                    style={{ fontSize: 22, color: incomeStatement.netIncome >= 0 ? "#86efac" : "#f87171" }}
                  >
                    {incomeStatement.netIncome.toFixed(0)}
                  </strong>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24 }}>
                <strong>Charges par catégorie</strong>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={secondaryButtonStyle} onClick={exportIncomePdf}>
                    Export PDF
                  </button>
                  <button style={secondaryButtonStyle} onClick={exportIncomeExcel}>
                    Export Excel
                  </button>
                </div>
              </div>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Catégorie</th>
                    <th style={thStyle}>Montant</th>
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
                        Aucune charge sur cette période.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {subTab === "balance" && balanceSheet && (
        <>
          <div style={{ display: "flex", gap: 16, marginTop: 24, flexWrap: "wrap" }}>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>Trésorerie</span>
              <strong style={{ fontSize: 22 }}>{balanceSheet.cash.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>Valeur du stock</span>
              <strong style={{ fontSize: 22 }}>{balanceSheet.stockValue.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>Créances clients</span>
              <strong style={{ fontSize: 22 }}>{balanceSheet.receivables.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>Total Actif</span>
              <strong style={{ fontSize: 22 }}>{balanceSheet.actifTotal.toFixed(0)}</strong>
            </div>
          </div>

          <div style={{ display: "flex", gap: 16, marginTop: 16, flexWrap: "wrap" }}>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>Dettes fournisseurs</span>
              <strong style={{ fontSize: 22 }}>{balanceSheet.payables.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>Total Passif</span>
              <strong style={{ fontSize: 22 }}>{balanceSheet.passifTotal.toFixed(0)}</strong>
            </div>
            <div style={cardStyle}>
              <span style={{ color: "var(--color-text-muted)" }}>Capitaux propres (résiduel)</span>
              <strong style={{ fontSize: 22, color: balanceSheet.equity >= 0 ? "#86efac" : "#f87171" }}>
                {balanceSheet.equity.toFixed(0)}
              </strong>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button style={secondaryButtonStyle} onClick={exportBalancePdf}>
              Export PDF
            </button>
            <button style={secondaryButtonStyle} onClick={exportBalanceExcel}>
              Export Excel
            </button>
          </div>
        </>
      )}
    </main>
  );
}
