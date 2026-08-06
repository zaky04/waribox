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
    ventes: "Journal des ventes (SYSCOHADA)",
    achats: "Journal des achats (SYSCOHADA)",
    tresorerie: "Journal de trésorerie (SYSCOHADA)",
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
    { key: "income", label: "Compte de résultat" },
    { key: "balance", label: "Bilan" },
    ...(syscohadaEnabled ? [{ key: "syscohada" as const, label: "Export SYSCOHADA" }] : []),
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
            <strong>Base de départ, à valider avec un comptable —</strong> le plan de comptes et le
            rattachement des catégories de dépenses aux comptes de charge sont une proposition standard
            SYSCOHADA, pas encore ajustés pour ce commerce précis. Les achats ne portent aucune TVA
            déductible (le schéma actuel n&apos;enregistre pas de TVA sur les achats), donc le compte 4452
            n&apos;apparaît jamais dans ces journaux — à corriger manuellement si vos fournisseurs facturent
            de la TVA récupérable.
          </div>

          <div style={{ ...cardStyle, flexDirection: "row", gap: 16, alignItems: "flex-end", marginTop: 16 }}>
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

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
              {(
                [
                  { key: "ventes", label: "Journal des ventes" },
                  { key: "achats", label: "Journal des achats" },
                  { key: "tresorerie", label: "Journal de trésorerie" },
                  { key: "balance", label: "Balance générale" },
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
            <div style={{ display: "flex", gap: 8 }}>
              <button style={secondaryButtonStyle} onClick={exportSyscohadaPdf}>
                Export PDF
              </button>
              <button style={secondaryButtonStyle} onClick={exportSyscohadaExcel}>
                Export Excel
              </button>
            </div>
          </div>

          {syscohadaView !== "balance" ? (
            <table style={{ ...tableStyle, marginTop: 16 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Pièce</th>
                  <th style={thStyle}>Compte</th>
                  <th style={thStyle}>Intitulé</th>
                  <th style={thStyle}>Libellé</th>
                  <th style={thStyle}>Débit</th>
                  <th style={thStyle}>Crédit</th>
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
                      Aucun mouvement sur cette période.
                    </td>
                  </tr>
                )}
              </tbody>
              {syscohadaLines.length > 0 && (
                <tfoot>
                  <tr>
                    <td style={tdStyle} colSpan={5}>
                      <strong>Total</strong>
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
                  <th style={thStyle}>Compte</th>
                  <th style={thStyle}>Intitulé</th>
                  <th style={thStyle}>Débit</th>
                  <th style={thStyle}>Crédit</th>
                  <th style={thStyle}>Solde</th>
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
                      Aucun mouvement sur cette période.
                    </td>
                  </tr>
                )}
              </tbody>
              {syscohadaBalance.length > 0 && (
                <tfoot>
                  <tr>
                    <td style={tdStyle} colSpan={2}>
                      <strong>Total</strong>
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
