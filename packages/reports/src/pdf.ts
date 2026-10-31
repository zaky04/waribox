import { t, formatAmountPlain } from "@gestion-boutique/i18n";
import { jsPDF } from "jspdf";

const TABLE_MARGIN_X = 14;
const TABLE_LINE_HEIGHT_MM = 6;
const TABLE_CELL_GUTTER_MM = 2;

// Colonnes de largeur égale par défaut (pas de `columnWeights`), ou
// proportionnelles aux poids fournis — un intitulé de compte SYSCOHADA ou
// une description de transaction est structurellement bien plus long qu'un
// code de compte ou une date, une largeur uniforme les fait alors déborder
// l'une sur l'autre (chevauchement visuel, texte illisible).
function computeColumnLayout(headerCount: number, columnWeights?: number[]): { x: number[]; width: number[] } {
  const usableWidth = 210 - TABLE_MARGIN_X * 2;
  const weights = columnWeights ?? Array(headerCount).fill(1);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const width = weights.map((w) => (usableWidth * w) / totalWeight);
  const x: number[] = [];
  let cursor = TABLE_MARGIN_X;
  for (const w of width) {
    x.push(cursor);
    cursor += w;
  }
  return { x, width };
}

// Retourne à la ligne chaque cellule dans la largeur de sa colonne (jsPDF ne
// le fait jamais spontanément avec `doc.text`, contrairement à un navigateur)
// — sans ça, tout contenu plus long que la colonne déborde purement et
// simplement sur la colonne suivante plutôt que d'être coupé ou de passer à
// la ligne, d'où le chevauchement observé en pratique sur le journal
// SYSCOHADA (numéro de pièce + code de compte, description de transaction).
function drawTableRow(
  doc: jsPDF,
  cells: (string | number)[],
  colX: number[],
  colWidth: number[],
  y: number,
): number {
  const wrapped = cells.map((cell, i) =>
    doc.splitTextToSize(String(cell), Math.max((colWidth[i] ?? 0) - TABLE_CELL_GUTTER_MM, 10)) as string[],
  );
  const lineCount = Math.max(1, ...wrapped.map((lines) => lines.length));
  wrapped.forEach((lines, i) => {
    lines.forEach((line, li) => doc.text(line, colX[i] ?? 0, y + li * TABLE_LINE_HEIGHT_MM));
  });
  return y + lineCount * TABLE_LINE_HEIGHT_MM;
}

function drawTable(
  doc: jsPDF,
  startY: number,
  headers: string[],
  rows: (string | number)[][],
  columnWeights?: number[],
): number {
  const { x: colX, width: colWidth } = computeColumnLayout(headers.length, columnWeights);
  let y = startY;

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  y = drawTableRow(doc, headers, colX, colWidth, y) + 1;
  doc.setFont("helvetica", "normal");

  for (const row of rows) {
    const wrapped = row.map((cell, i) =>
      doc.splitTextToSize(String(cell), Math.max((colWidth[i] ?? 0) - TABLE_CELL_GUTTER_MM, 10)) as string[],
    );
    const rowHeight = Math.max(1, ...wrapped.map((lines) => lines.length)) * TABLE_LINE_HEIGHT_MM;
    if (y + rowHeight > 285) {
      doc.addPage();
      y = 20;
    }
    y = drawTableRow(doc, row, colX, colWidth, y);
  }

  return y;
}

// Retourne à la ligne le sous-titre (souvent une phrase interpolée avec
// plusieurs valeurs — dates, montants, compteurs) plutôt que de le laisser
// déborder hors de la page, et décale le début du tableau en conséquence
// pour ne jamais chevaucher une deuxième ligne de sous-titre.
function drawWrappedSubtitle(doc: jsPDF, subtitle: string, y: number): number {
  const lines = doc.splitTextToSize(subtitle, 210 - TABLE_MARGIN_X * 2) as string[];
  doc.text(lines, TABLE_MARGIN_X, y);
  return y + lines.length * TABLE_LINE_HEIGHT_MM;
}

function buildReportPdf(
  title: string,
  subtitle: string,
  headers: string[],
  rows: (string | number)[][],
  columnWeights?: number[],
): Blob {
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(title, 14, 18);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  const tableStartY = drawWrappedSubtitle(doc, subtitle, 26) + 4;
  drawTable(doc, tableStartY, headers, rows, columnWeights);
  return doc.output("blob");
}

export interface SalesReportData {
  from: string;
  to: string;
  totalRevenue: number;
  saleCount: number;
  averageBasket: number;
  byDay: { date: string; total: number }[];
  topProducts: { name: string; quantity: number; revenue: number }[];
}

export function buildSalesReportPdf(data: SalesReportData): Blob {
  const rows = data.topProducts.map((p) => [p.name, p.quantity, formatAmountPlain(p.revenue)]);
  return buildReportPdf(
    t("documents.reports.sales.title"),
    t("documents.reports.sales.subtitle", {
      from: data.from,
      to: data.to,
      totalRevenue: formatAmountPlain(data.totalRevenue),
      saleCount: data.saleCount,
      averageBasket: formatAmountPlain(data.averageBasket),
    }),
    [
      t("documents.reports.sales.columnProduct"),
      t("documents.reports.sales.columnQuantity"),
      t("documents.reports.sales.columnRevenue"),
    ],
    rows,
  );
}

export interface MarginsReportData {
  from: string;
  to: string;
  revenue: number;
  cost: number;
  margin: number;
  marginRate: number;
  byDay: { date: string; margin: number }[];
  productBreakdown?: {
    name: string;
    quantity: number;
    margin: number;
    marginRate: number;
    marginShare: number;
    cumulativeShare: number;
    abcClass: "A" | "B" | "C";
  }[];
}

export function buildMarginsReportPdf(data: MarginsReportData): Blob {
  const rows = data.byDay.map((d) => [d.date, formatAmountPlain(d.margin)]);
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(t("documents.reports.margins.title"), 14, 18);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  const subtitleEndY = drawWrappedSubtitle(
    doc,
    t("documents.reports.margins.subtitle", {
      from: data.from,
      to: data.to,
      revenue: formatAmountPlain(data.revenue),
      cost: formatAmountPlain(data.cost),
      margin: formatAmountPlain(data.margin),
      marginRate: data.marginRate.toFixed(1),
    }),
    26,
  );
  let y = drawTable(
    doc,
    subtitleEndY + 4,
    [t("documents.reports.margins.columnDate"), t("documents.reports.margins.columnMargin")],
    rows,
  );

  if (data.productBreakdown && data.productBreakdown.length > 0) {
    y += 10;
    if (y > 260) {
      doc.addPage();
      y = 20;
    }
    doc.setFont("helvetica", "bold");
    doc.text(t("documents.reports.margins.breakdownHeading"), 14, y);
    y += 8;
    doc.setFont("helvetica", "normal");
    const productRows = data.productBreakdown.map((p) => [
      p.name,
      p.quantity,
      formatAmountPlain(p.margin),
      `${p.marginRate.toFixed(1)}%`,
      `${p.cumulativeShare.toFixed(1)}%`,
      p.abcClass,
    ]);
    drawTable(
      doc,
      y,
      [
        t("documents.reports.margins.columnProduct"),
        t("documents.reports.margins.columnQty"),
        t("documents.reports.margins.columnMargin"),
        t("documents.reports.margins.columnRate"),
        t("documents.reports.margins.columnCumulative"),
        t("documents.reports.margins.columnClass"),
      ],
      productRows,
      // Le nom du produit a besoin de bien plus de place que les 5 autres
      // colonnes (pourcentages/lettre de classe, toujours courts) — une
      // répartition égale forcerait un retour à la ligne systématique sur
      // cette seule colonne.
      [3, 1, 1, 1, 1, 1],
    );
  }

  return doc.output("blob");
}

export interface CashFlowReportData {
  byMonth: { month: string; cashIn: number; cashOut: number; net: number }[];
  projection?: {
    years: number;
    growthRate: number;
    byYear: { year: number; projectedIn: number; projectedOut: number; projectedNet: number; cumulative: number }[];
  };
}

export function buildCashFlowReportPdf(data: CashFlowReportData): Blob {
  const rows = data.byMonth.map((m) => [m.month, formatAmountPlain(m.cashIn), formatAmountPlain(m.cashOut), formatAmountPlain(m.net)]);
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(t("documents.reports.cashFlow.title"), 14, 18);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  let y = drawTable(
    doc,
    30,
    [
      t("documents.reports.cashFlow.columnMonth"),
      t("documents.reports.cashFlow.columnIn"),
      t("documents.reports.cashFlow.columnOut"),
      t("documents.reports.cashFlow.columnNet"),
    ],
    rows,
  );

  if (data.projection) {
    y += 10;
    if (y > 260) {
      doc.addPage();
      y = 20;
    }
    doc.setFont("helvetica", "bold");
    y = drawWrappedSubtitle(
      doc,
      t("documents.reports.cashFlow.projectionSubtitle", {
        years: data.projection.years,
        growthRate: data.projection.growthRate,
      }),
      y,
    );
    y += 4;
    doc.setFont("helvetica", "normal");
    const projRows = data.projection.byYear.map((p) => [
      p.year,
      formatAmountPlain(p.projectedIn),
      formatAmountPlain(p.projectedOut),
      formatAmountPlain(p.projectedNet),
      formatAmountPlain(p.cumulative),
    ]);
    drawTable(
      doc,
      y,
      [
        t("documents.reports.cashFlow.columnYear"),
        t("documents.reports.cashFlow.columnIn"),
        t("documents.reports.cashFlow.columnOut"),
        t("documents.reports.cashFlow.columnNet"),
        t("documents.reports.cashFlow.columnCumulative"),
      ],
      projRows,
    );
  }

  return doc.output("blob");
}

export interface IncomeStatementReportData {
  from: string;
  to: string;
  salesRevenue: number;
  serviceRevenue: number;
  revenue: number;
  cogs: number;
  expensesTotal: number;
  expensesByCategory: { category: string; amount: number }[];
  netIncome: number;
}

export function buildIncomeStatementReportPdf(data: IncomeStatementReportData): Blob {
  const rows = data.expensesByCategory.map((e) => [e.category, formatAmountPlain(e.amount)]);
  return buildReportPdf(
    t("documents.reports.incomeStatement.title"),
    t("documents.reports.incomeStatement.subtitle", {
      from: data.from,
      to: data.to,
      revenue: formatAmountPlain(data.revenue),
      cogs: formatAmountPlain(data.cogs),
      expensesTotal: formatAmountPlain(data.expensesTotal),
      netIncome: formatAmountPlain(data.netIncome),
    }),
    [t("documents.reports.incomeStatement.columnCategory"), t("documents.reports.incomeStatement.columnAmount")],
    rows,
  );
}

export interface TaxReportData {
  from: string;
  to: string;
  totalTaxCollected: number;
  salesTaxTotal: number;
  refundsTaxTotal: number;
  taxableRevenue: number;
  byDay: { date: string; taxCollected: number }[];
}

export function buildTaxReportPdf(data: TaxReportData): Blob {
  const rows = data.byDay.map((d) => [d.date, formatAmountPlain(d.taxCollected)]);
  return buildReportPdf(
    t("documents.reports.tax.title"),
    t("documents.reports.tax.subtitle", {
      from: data.from,
      to: data.to,
      salesTaxTotal: formatAmountPlain(data.salesTaxTotal),
      refundsTaxTotal: formatAmountPlain(data.refundsTaxTotal),
      totalTaxCollected: formatAmountPlain(data.totalTaxCollected),
    }),
    [t("documents.reports.tax.columnDate"), t("documents.reports.tax.columnTaxCollected")],
    rows,
  );
}

export interface BalanceSheetReportData {
  asOfDate: string;
  cash: number;
  stockValue: number;
  receivables: number;
  actifTotal: number;
  payables: number;
  passifTotal: number;
  equity: number;
}

export function buildBalanceSheetReportPdf(data: BalanceSheetReportData): Blob {
  const rows: (string | number)[][] = [
    [t("documents.reports.balanceSheet.rowCash"), formatAmountPlain(data.cash)],
    [t("documents.reports.balanceSheet.rowStockValue"), formatAmountPlain(data.stockValue)],
    [t("documents.reports.balanceSheet.rowReceivables"), formatAmountPlain(data.receivables)],
    [t("documents.reports.balanceSheet.rowTotalAssets"), formatAmountPlain(data.actifTotal)],
    [t("documents.reports.balanceSheet.rowPayables"), formatAmountPlain(data.payables)],
    [t("documents.reports.balanceSheet.rowTotalLiabilities"), formatAmountPlain(data.passifTotal)],
    [t("documents.reports.balanceSheet.rowEquity"), formatAmountPlain(data.equity)],
  ];
  return buildReportPdf(
    t("documents.reports.balanceSheet.title"),
    t("documents.reports.balanceSheet.subtitle", { asOfDate: data.asOfDate }),
    [t("documents.reports.balanceSheet.columnItem"), t("documents.reports.balanceSheet.columnAmount")],
    rows,
  );
}

export interface SyscohadaJournalLine {
  date: string;
  piece: string;
  compte: string;
  intitule: string;
  libelle: string;
  debit: number;
  credit: number;
}

export interface SyscohadaJournalReportData {
  title: string;
  from: string;
  to: string;
  lines: SyscohadaJournalLine[];
}

export function buildSyscohadaJournalPdf(data: SyscohadaJournalReportData): Blob {
  const totalDebit = data.lines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredit = data.lines.reduce((sum, l) => sum + l.credit, 0);
  const rows = data.lines.map((l) => [
    l.date,
    l.piece,
    l.compte,
    l.intitule,
    l.libelle,
    l.debit > 0 ? formatAmountPlain(l.debit) : "",
    l.credit > 0 ? formatAmountPlain(l.credit) : "",
  ]);
  return buildReportPdf(
    data.title,
    t("documents.reports.syscohadaJournal.subtitle", {
      from: data.from,
      to: data.to,
      totalDebit: formatAmountPlain(totalDebit),
      totalCredit: formatAmountPlain(totalCredit),
    }),
    [
      t("documents.reports.syscohadaJournal.columnDate"),
      t("documents.reports.syscohadaJournal.columnPiece"),
      t("documents.reports.syscohadaJournal.columnAccount"),
      t("documents.reports.syscohadaJournal.columnLabel"),
      t("documents.reports.syscohadaJournal.columnDescription"),
      t("documents.reports.syscohadaJournal.columnDebit"),
      t("documents.reports.syscohadaJournal.columnCredit"),
    ],
    rows,
    // Intitulé (nom de compte) et Libellé (description de transaction) sont
    // du texte libre potentiellement long ("État, TVA facturée sur ventes de
    // marchandises", "Vente VTE-2026-000001 — Client comptant") — bien plus
    // que les codes/dates/montants des 5 autres colonnes. "Compte"/"Account"
    // reste plus large que son propre contenu (3-4 chiffres) car c'est
    // l'intitulé de colonne lui-même le plus large élément de cette colonne.
    [1.3, 1.6, 1.0, 2.3, 2.6, 1.0, 1.0],
  );
}

export interface SyscohadaBalanceReportData {
  from: string;
  to: string;
  rows: { compte: string; intitule: string; debit: number; credit: number; solde: number }[];
}

export function buildSyscohadaBalancePdf(data: SyscohadaBalanceReportData): Blob {
  const totalDebit = data.rows.reduce((sum, r) => sum + r.debit, 0);
  const totalCredit = data.rows.reduce((sum, r) => sum + r.credit, 0);
  const rows = data.rows.map((r) => [
    r.compte,
    r.intitule,
    formatAmountPlain(r.debit),
    formatAmountPlain(r.credit),
    formatAmountPlain(r.solde),
  ]);
  return buildReportPdf(
    t("documents.reports.syscohadaBalance.title"),
    t("documents.reports.syscohadaBalance.subtitle", {
      from: data.from,
      to: data.to,
      totalDebit: formatAmountPlain(totalDebit),
      totalCredit: formatAmountPlain(totalCredit),
    }),
    [
      t("documents.reports.syscohadaBalance.columnAccount"),
      t("documents.reports.syscohadaBalance.columnLabel"),
      t("documents.reports.syscohadaBalance.columnDebit"),
      t("documents.reports.syscohadaBalance.columnCredit"),
      t("documents.reports.syscohadaBalance.columnBalance"),
    ],
    rows,
    [1.1, 2.2, 1, 1, 1],
  );
}

export interface CashSessionReportRow {
  userName: string;
  openedAt: string;
  openingAmount: number;
  closedAt: string | null;
  closingAmount: number | null;
  expectedAmount: number | null;
  difference: number | null;
}

export interface CashSessionsReportData {
  from: string;
  to: string;
  rows: CashSessionReportRow[];
}

export function buildCashSessionsReportPdf(data: CashSessionsReportData): Blob {
  const totalDifference = data.rows.reduce((sum, r) => sum + (r.difference ?? 0), 0);
  const rows = data.rows.map((r) => [
    r.openedAt,
    r.userName,
    formatAmountPlain(r.openingAmount),
    r.closedAt ?? t("documents.reports.ongoing"),
    r.closingAmount != null ? formatAmountPlain(r.closingAmount) : "—",
    r.expectedAmount != null ? formatAmountPlain(r.expectedAmount) : "—",
    r.difference != null ? formatAmountPlain(r.difference) : "—",
  ]);
  return buildReportPdf(
    t("documents.reports.cashSessions.title"),
    t("documents.reports.cashSessions.subtitle", {
      from: data.from,
      to: data.to,
      count: data.rows.length,
      totalDifference: formatAmountPlain(totalDifference),
    }),
    [
      t("documents.reports.cashSessions.columnOpenedAt"),
      t("documents.reports.cashSessions.columnCashier"),
      t("documents.reports.cashSessions.columnOpeningAmount"),
      t("documents.reports.cashSessions.columnClosedAt"),
      t("documents.reports.cashSessions.columnClosingAmount"),
      t("documents.reports.cashSessions.columnExpected"),
      t("documents.reports.cashSessions.columnDifference"),
    ],
    rows,
  );
}
