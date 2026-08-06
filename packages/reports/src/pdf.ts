import { jsPDF } from "jspdf";

function drawTable(
  doc: jsPDF,
  startY: number,
  headers: string[],
  rows: (string | number)[][],
): number {
  const marginX = 14;
  const colWidth = (210 - marginX * 2) / headers.length;
  let y = startY;

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  headers.forEach((header, i) => {
    doc.text(String(header), marginX + i * colWidth, y);
  });
  y += 6;
  doc.setFont("helvetica", "normal");

  for (const row of rows) {
    if (y > 280) {
      doc.addPage();
      y = 20;
    }
    row.forEach((cell, i) => {
      doc.text(String(cell), marginX + i * colWidth, y);
    });
    y += 6;
  }

  return y;
}

function buildReportPdf(title: string, subtitle: string, headers: string[], rows: (string | number)[][]): Blob {
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(title, 14, 18);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(subtitle, 14, 26);
  drawTable(doc, 36, headers, rows);
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
  const rows = data.topProducts.map((p) => [p.name, p.quantity, p.revenue.toFixed(0)]);
  return buildReportPdf(
    "Rapport des ventes",
    `Du ${data.from} au ${data.to} — CA total : ${data.totalRevenue.toFixed(0)} — Ventes : ${data.saleCount} — Panier moyen : ${data.averageBasket.toFixed(0)}`,
    ["Produit", "Quantité", "Revenu"],
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
  const rows = data.byDay.map((d) => [d.date, d.margin.toFixed(0)]);
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text("Rapport des marges", 14, 18);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(
    `Du ${data.from} au ${data.to} — Revenu : ${data.revenue.toFixed(0)} — Coût : ${data.cost.toFixed(0)} — Marge : ${data.margin.toFixed(0)} (${data.marginRate.toFixed(1)}%)`,
    14,
    26,
  );
  let y = drawTable(doc, 36, ["Date", "Marge"], rows);

  if (data.productBreakdown && data.productBreakdown.length > 0) {
    y += 10;
    if (y > 260) {
      doc.addPage();
      y = 20;
    }
    doc.setFont("helvetica", "bold");
    doc.text("Produits les plus rentables (analyse ABC)", 14, y);
    y += 8;
    doc.setFont("helvetica", "normal");
    const productRows = data.productBreakdown.map((p) => [
      p.name,
      p.quantity,
      p.margin.toFixed(0),
      `${p.marginRate.toFixed(1)}%`,
      `${p.cumulativeShare.toFixed(1)}%`,
      p.abcClass,
    ]);
    drawTable(doc, y, ["Produit", "Qté", "Marge", "Taux", "Cumul", "Classe"], productRows);
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
  const rows = data.byMonth.map((m) => [m.month, m.cashIn.toFixed(0), m.cashOut.toFixed(0), m.net.toFixed(0)]);
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text("Rapport de trésorerie", 14, 18);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  let y = drawTable(doc, 30, ["Mois", "Entrées", "Sorties", "Net"], rows);

  if (data.projection) {
    y += 10;
    if (y > 260) {
      doc.addPage();
      y = 20;
    }
    doc.setFont("helvetica", "bold");
    doc.text(
      `Projection sur ${data.projection.years} an(s) — croissance annuelle : ${data.projection.growthRate}%`,
      14,
      y,
    );
    y += 8;
    doc.setFont("helvetica", "normal");
    const projRows = data.projection.byYear.map((p) => [
      p.year,
      p.projectedIn.toFixed(0),
      p.projectedOut.toFixed(0),
      p.projectedNet.toFixed(0),
      p.cumulative.toFixed(0),
    ]);
    drawTable(doc, y, ["Année", "Entrées", "Sorties", "Net", "Cumulé"], projRows);
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
  const rows = data.expensesByCategory.map((e) => [e.category, e.amount.toFixed(0)]);
  return buildReportPdf(
    "Compte de résultat (simplifié)",
    `Du ${data.from} au ${data.to} — CA : ${data.revenue.toFixed(0)} — Coût des ventes : ${data.cogs.toFixed(0)} — Charges : ${data.expensesTotal.toFixed(0)} — Résultat net : ${data.netIncome.toFixed(0)}`,
    ["Catégorie de charge", "Montant"],
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
  const rows = data.byDay.map((d) => [d.date, d.taxCollected.toFixed(0)]);
  return buildReportPdf(
    "Rapport TVA collectée",
    `Du ${data.from} au ${data.to} — TVA ventes : ${data.salesTaxTotal.toFixed(0)} — TVA remboursée : ${data.refundsTaxTotal.toFixed(0)} — TVA nette : ${data.totalTaxCollected.toFixed(0)}`,
    ["Date", "TVA collectée"],
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
    ["Trésorerie", data.cash.toFixed(0)],
    ["Valeur du stock", data.stockValue.toFixed(0)],
    ["Créances clients", data.receivables.toFixed(0)],
    ["Total Actif", data.actifTotal.toFixed(0)],
    ["Dettes fournisseurs", data.payables.toFixed(0)],
    ["Total Passif", data.passifTotal.toFixed(0)],
    ["Capitaux propres (résiduel)", data.equity.toFixed(0)],
  ];
  return buildReportPdf("Bilan (simplifié, non certifié)", `Au ${data.asOfDate}`, ["Poste", "Montant"], rows);
}
