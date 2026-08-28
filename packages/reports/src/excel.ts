import { t } from "@gestion-boutique/i18n";
import * as XLSX from "xlsx";
import type {
  BalanceSheetReportData,
  CashFlowReportData,
  CashSessionsReportData,
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
      name: t("documents.reports.sales.excel.summarySheet"),
      rows: [
        {
          [t("documents.reports.sales.excel.period")]: `${data.from} → ${data.to}`,
          [t("documents.reports.sales.excel.totalRevenue")]: data.totalRevenue,
          [t("documents.reports.sales.excel.sales")]: data.saleCount,
          [t("documents.reports.sales.excel.averageBasket")]: data.averageBasket,
        },
      ],
    },
    {
      name: t("documents.reports.sales.excel.byDaySheet"),
      rows: data.byDay.map((d) => ({
        [t("documents.reports.sales.excel.date")]: d.date,
        [t("documents.reports.sales.excel.total")]: d.total,
      })),
    },
    {
      name: t("documents.reports.sales.excel.productsSheet"),
      rows: data.topProducts.map((p) => ({
        [t("documents.reports.sales.excel.product")]: p.name,
        [t("documents.reports.sales.excel.quantity")]: p.quantity,
        [t("documents.reports.sales.excel.revenue")]: p.revenue,
      })),
    },
  ]);
}

export function buildMarginsReportExcel(data: MarginsReportData): Blob {
  const sheets: { name: string; rows: Record<string, unknown>[] }[] = [
    {
      name: t("documents.reports.margins.excel.summarySheet"),
      rows: [
        {
          [t("documents.reports.margins.excel.period")]: `${data.from} → ${data.to}`,
          [t("documents.reports.margins.excel.revenue")]: data.revenue,
          [t("documents.reports.margins.excel.cost")]: data.cost,
          [t("documents.reports.margins.excel.margin")]: data.margin,
          [t("documents.reports.margins.excel.ratePercent")]: data.marginRate,
        },
      ],
    },
    {
      name: t("documents.reports.margins.excel.byDaySheet"),
      rows: data.byDay.map((d) => ({
        [t("documents.reports.margins.excel.date")]: d.date,
        [t("documents.reports.margins.excel.margin")]: d.margin,
      })),
    },
  ];
  if (data.productBreakdown && data.productBreakdown.length > 0) {
    sheets.push({
      name: t("documents.reports.margins.excel.productsSheet"),
      rows: data.productBreakdown.map((p) => ({
        [t("documents.reports.margins.excel.product")]: p.name,
        [t("documents.reports.margins.excel.quantity")]: p.quantity,
        [t("documents.reports.margins.excel.margin")]: p.margin,
        [t("documents.reports.margins.excel.ratePercent")]: p.marginRate,
        [t("documents.reports.margins.excel.marginSharePercent")]: p.marginShare,
        [t("documents.reports.margins.excel.cumulativePercent")]: p.cumulativeShare,
        [t("documents.reports.margins.excel.class")]: p.abcClass,
      })),
    });
  }
  return buildWorkbookBlob(sheets);
}

export function buildCashFlowReportExcel(data: CashFlowReportData): Blob {
  const sheets: { name: string; rows: Record<string, unknown>[] }[] = [
    {
      name: t("documents.reports.cashFlow.excel.byMonthSheet"),
      rows: data.byMonth.map((m) => ({
        [t("documents.reports.cashFlow.excel.month")]: m.month,
        [t("documents.reports.cashFlow.excel.in")]: m.cashIn,
        [t("documents.reports.cashFlow.excel.out")]: m.cashOut,
        [t("documents.reports.cashFlow.excel.net")]: m.net,
      })),
    },
  ];

  if (data.projection) {
    sheets.push({
      name: t("documents.reports.cashFlow.excel.projectionSheet"),
      rows: data.projection.byYear.map((p) => ({
        [t("documents.reports.cashFlow.excel.year")]: p.year,
        [t("documents.reports.cashFlow.excel.in")]: p.projectedIn,
        [t("documents.reports.cashFlow.excel.out")]: p.projectedOut,
        [t("documents.reports.cashFlow.excel.net")]: p.projectedNet,
        [t("documents.reports.cashFlow.excel.cumulative")]: p.cumulative,
      })),
    });
  }

  return buildWorkbookBlob(sheets);
}

export function buildIncomeStatementReportExcel(data: IncomeStatementReportData): Blob {
  return buildWorkbookBlob([
    {
      name: t("documents.reports.incomeStatement.excel.summarySheet"),
      rows: [
        {
          [t("documents.reports.incomeStatement.excel.period")]: `${data.from} → ${data.to}`,
          [t("documents.reports.incomeStatement.excel.salesRevenue")]: data.salesRevenue,
          [t("documents.reports.incomeStatement.excel.serviceRevenue")]: data.serviceRevenue,
          [t("documents.reports.incomeStatement.excel.totalRevenue")]: data.revenue,
          [t("documents.reports.incomeStatement.excel.cogs")]: data.cogs,
          [t("documents.reports.incomeStatement.excel.expenses")]: data.expensesTotal,
          [t("documents.reports.incomeStatement.excel.netIncome")]: data.netIncome,
        },
      ],
    },
    {
      name: t("documents.reports.incomeStatement.excel.byCategorySheet"),
      rows: data.expensesByCategory.map((e) => ({
        [t("documents.reports.incomeStatement.excel.category")]: e.category,
        [t("documents.reports.incomeStatement.excel.amount")]: e.amount,
      })),
    },
  ]);
}

export function buildTaxReportExcel(data: TaxReportData): Blob {
  return buildWorkbookBlob([
    {
      name: t("documents.reports.tax.excel.summarySheet"),
      rows: [
        {
          [t("documents.reports.tax.excel.period")]: `${data.from} → ${data.to}`,
          [t("documents.reports.tax.excel.salesTax")]: data.salesTaxTotal,
          [t("documents.reports.tax.excel.refundsTax")]: data.refundsTaxTotal,
          [t("documents.reports.tax.excel.netTax")]: data.totalTaxCollected,
          [t("documents.reports.tax.excel.taxableRevenue")]: data.taxableRevenue,
        },
      ],
    },
    {
      name: t("documents.reports.tax.excel.byDaySheet"),
      rows: data.byDay.map((d) => ({
        [t("documents.reports.tax.excel.date")]: d.date,
        [t("documents.reports.tax.excel.taxCollected")]: d.taxCollected,
      })),
    },
  ]);
}

export function buildBalanceSheetReportExcel(data: BalanceSheetReportData): Blob {
  return buildWorkbookBlob([
    {
      name: t("documents.reports.balanceSheet.excel.sheet"),
      rows: [
        { [t("documents.reports.balanceSheet.columnItem")]: t("documents.reports.balanceSheet.rowCash"), [t("documents.reports.balanceSheet.columnAmount")]: data.cash },
        { [t("documents.reports.balanceSheet.columnItem")]: t("documents.reports.balanceSheet.rowStockValue"), [t("documents.reports.balanceSheet.columnAmount")]: data.stockValue },
        { [t("documents.reports.balanceSheet.columnItem")]: t("documents.reports.balanceSheet.rowReceivables"), [t("documents.reports.balanceSheet.columnAmount")]: data.receivables },
        { [t("documents.reports.balanceSheet.columnItem")]: t("documents.reports.balanceSheet.rowTotalAssets"), [t("documents.reports.balanceSheet.columnAmount")]: data.actifTotal },
        { [t("documents.reports.balanceSheet.columnItem")]: t("documents.reports.balanceSheet.rowPayables"), [t("documents.reports.balanceSheet.columnAmount")]: data.payables },
        { [t("documents.reports.balanceSheet.columnItem")]: t("documents.reports.balanceSheet.rowTotalLiabilities"), [t("documents.reports.balanceSheet.columnAmount")]: data.passifTotal },
        { [t("documents.reports.balanceSheet.columnItem")]: t("documents.reports.balanceSheet.rowEquity"), [t("documents.reports.balanceSheet.columnAmount")]: data.equity },
      ],
    },
  ]);
}

export function buildSyscohadaJournalExcel(data: SyscohadaJournalReportData): Blob {
  return buildWorkbookBlob([
    {
      name: data.title.slice(0, 31),
      rows: data.lines.map((l) => ({
        [t("documents.reports.syscohadaJournal.excel.date")]: l.date,
        [t("documents.reports.syscohadaJournal.excel.piece")]: l.piece,
        [t("documents.reports.syscohadaJournal.excel.account")]: l.compte,
        [t("documents.reports.syscohadaJournal.excel.label")]: l.intitule,
        [t("documents.reports.syscohadaJournal.excel.description")]: l.libelle,
        [t("documents.reports.syscohadaJournal.excel.debit")]: l.debit || "",
        [t("documents.reports.syscohadaJournal.excel.credit")]: l.credit || "",
      })),
    },
  ]);
}

export function buildSyscohadaBalanceExcel(data: SyscohadaBalanceReportData): Blob {
  return buildWorkbookBlob([
    {
      name: t("documents.reports.syscohadaBalance.excel.sheet"),
      rows: data.rows.map((r) => ({
        [t("documents.reports.syscohadaBalance.excel.account")]: r.compte,
        [t("documents.reports.syscohadaBalance.excel.label")]: r.intitule,
        [t("documents.reports.syscohadaBalance.excel.debit")]: r.debit,
        [t("documents.reports.syscohadaBalance.excel.credit")]: r.credit,
        [t("documents.reports.syscohadaBalance.excel.balance")]: r.solde,
      })),
    },
  ]);
}

export function buildCashSessionsReportExcel(data: CashSessionsReportData): Blob {
  return buildWorkbookBlob([
    {
      name: t("documents.reports.cashSessions.excel.sheet"),
      rows: data.rows.map((r) => ({
        [t("documents.reports.cashSessions.excel.openedAt")]: r.openedAt,
        [t("documents.reports.cashSessions.excel.cashier")]: r.userName,
        [t("documents.reports.cashSessions.excel.openingAmount")]: r.openingAmount,
        [t("documents.reports.cashSessions.excel.closedAt")]: r.closedAt ?? t("documents.reports.ongoing"),
        [t("documents.reports.cashSessions.excel.closingAmount")]: r.closingAmount ?? "",
        [t("documents.reports.cashSessions.excel.expected")]: r.expectedAmount ?? "",
        [t("documents.reports.cashSessions.excel.difference")]: r.difference ?? "",
      })),
    },
  ]);
}
