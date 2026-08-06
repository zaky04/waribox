import * as XLSX from "xlsx";
import type {
  BalanceSheetReportData,
  CashFlowReportData,
  IncomeStatementReportData,
  MarginsReportData,
  SalesReportData,
  SyscohadaBalanceReportData,
  SyscohadaJournalReportData,
  TaxReportData,
} from "./pdf";

function buildWorkbookBlob(sheets: { name: string; rows: Record<string, unknown>[] }[]): Blob {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const worksheet = XLSX.utils.json_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function buildSalesReportExcel(data: SalesReportData): Blob {
  return buildWorkbookBlob([
    {
      name: "Résumé",
      rows: [
        {
          Période: `${data.from} → ${data.to}`,
          "CA total": data.totalRevenue,
          Ventes: data.saleCount,
          "Panier moyen": data.averageBasket,
        },
      ],
    },
    {
      name: "Par jour",
      rows: data.byDay.map((d) => ({ Date: d.date, Total: d.total })),
    },
    {
      name: "Produits",
      rows: data.topProducts.map((p) => ({ Produit: p.name, Quantité: p.quantity, Revenu: p.revenue })),
    },
  ]);
}

export function buildMarginsReportExcel(data: MarginsReportData): Blob {
  const sheets: { name: string; rows: Record<string, unknown>[] }[] = [
    {
      name: "Résumé",
      rows: [
        {
          Période: `${data.from} → ${data.to}`,
          Revenu: data.revenue,
          Coût: data.cost,
          Marge: data.margin,
          "Taux (%)": data.marginRate,
        },
      ],
    },
    {
      name: "Par jour",
      rows: data.byDay.map((d) => ({ Date: d.date, Marge: d.margin })),
    },
  ];
  if (data.productBreakdown && data.productBreakdown.length > 0) {
    sheets.push({
      name: "Produits (ABC)",
      rows: data.productBreakdown.map((p) => ({
        Produit: p.name,
        Quantité: p.quantity,
        Marge: p.margin,
        "Taux (%)": p.marginRate,
        "Part marge (%)": p.marginShare,
        "Cumul (%)": p.cumulativeShare,
        Classe: p.abcClass,
      })),
    });
  }
  return buildWorkbookBlob(sheets);
}

export function buildCashFlowReportExcel(data: CashFlowReportData): Blob {
  const sheets: { name: string; rows: Record<string, unknown>[] }[] = [
    {
      name: "Par mois",
      rows: data.byMonth.map((m) => ({
        Mois: m.month,
        Entrées: m.cashIn,
        Sorties: m.cashOut,
        Net: m.net,
      })),
    },
  ];

  if (data.projection) {
    sheets.push({
      name: "Projection",
      rows: data.projection.byYear.map((p) => ({
        Année: p.year,
        Entrées: p.projectedIn,
        Sorties: p.projectedOut,
        Net: p.projectedNet,
        Cumulé: p.cumulative,
      })),
    });
  }

  return buildWorkbookBlob(sheets);
}

export function buildIncomeStatementReportExcel(data: IncomeStatementReportData): Blob {
  return buildWorkbookBlob([
    {
      name: "Résumé",
      rows: [
        {
          Période: `${data.from} → ${data.to}`,
          "CA ventes": data.salesRevenue,
          "CA services": data.serviceRevenue,
          "CA total": data.revenue,
          "Coût des ventes": data.cogs,
          Charges: data.expensesTotal,
          "Résultat net": data.netIncome,
        },
      ],
    },
    {
      name: "Charges par catégorie",
      rows: data.expensesByCategory.map((e) => ({ Catégorie: e.category, Montant: e.amount })),
    },
  ]);
}

export function buildTaxReportExcel(data: TaxReportData): Blob {
  return buildWorkbookBlob([
    {
      name: "Résumé",
      rows: [
        {
          Période: `${data.from} → ${data.to}`,
          "TVA ventes": data.salesTaxTotal,
          "TVA remboursée": data.refundsTaxTotal,
          "TVA nette collectée": data.totalTaxCollected,
          "CA taxable (TTC net)": data.taxableRevenue,
        },
      ],
    },
    {
      name: "Par jour",
      rows: data.byDay.map((d) => ({ Date: d.date, "TVA collectée": d.taxCollected })),
    },
  ]);
}

export function buildBalanceSheetReportExcel(data: BalanceSheetReportData): Blob {
  return buildWorkbookBlob([
    {
      name: "Bilan",
      rows: [
        { Poste: "Trésorerie", Montant: data.cash },
        { Poste: "Valeur du stock", Montant: data.stockValue },
        { Poste: "Créances clients", Montant: data.receivables },
        { Poste: "Total Actif", Montant: data.actifTotal },
        { Poste: "Dettes fournisseurs", Montant: data.payables },
        { Poste: "Total Passif", Montant: data.passifTotal },
        { Poste: "Capitaux propres (résiduel)", Montant: data.equity },
      ],
    },
  ]);
}

export function buildSyscohadaJournalExcel(data: SyscohadaJournalReportData): Blob {
  return buildWorkbookBlob([
    {
      name: data.title.slice(0, 31),
      rows: data.lines.map((l) => ({
        Date: l.date,
        Pièce: l.piece,
        Compte: l.compte,
        Intitulé: l.intitule,
        Libellé: l.libelle,
        Débit: l.debit || "",
        Crédit: l.credit || "",
      })),
    },
  ]);
}

export function buildSyscohadaBalanceExcel(data: SyscohadaBalanceReportData): Blob {
  return buildWorkbookBlob([
    {
      name: "Balance générale",
      rows: data.rows.map((r) => ({
        Compte: r.compte,
        Intitulé: r.intitule,
        Débit: r.debit,
        Crédit: r.credit,
        Solde: r.solde,
      })),
    },
  ]);
}
