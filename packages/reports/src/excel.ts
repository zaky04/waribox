import * as XLSX from "xlsx";
import type {
  BalanceSheetReportData,
  CashFlowReportData,
  IncomeStatementReportData,
  MarginsReportData,
  SalesReportData,
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
  return buildWorkbookBlob([
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
  ]);
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
