import { t } from "@gestion-boutique/i18n";
import { jsPDF } from "jspdf";

export interface QuotePdfData {
  businessName?: string;
  businessAddress?: string;
  businessPhone?: string;
  businessEmail?: string;
  quoteNumber: string;
  date: string;
  validUntil?: string;
  customerName?: string;
  lines: { description: string; quantity: number; unitPrice: number; total: number }[];
  subtotal: number;
  tax: number;
  total: number;
}

// Format A4 (document commercial classique), contrairement aux tickets de
// caisse/service (thermiques, format papier étroit) — mise en page distincte,
// voir receiptPdf.ts pour ceux-là.
export function buildQuotePdf(data: QuotePdfData): Blob {
  const doc = new jsPDF();
  const marginX = 14;

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(data.businessName ?? "WariBox", marginX, 18);

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  let y = 26;
  if (data.businessAddress) {
    doc.text(data.businessAddress, marginX, y);
    y += 6;
  }
  if (data.businessPhone) {
    doc.text(t("documents.common.phone", { phone: data.businessPhone }), marginX, y);
    y += 6;
  }
  if (data.businessEmail) {
    doc.text(data.businessEmail, marginX, y);
    y += 6;
  }

  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text(t("documents.quote.title", { number: data.quoteNumber }), marginX, y + 8);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(t("documents.quote.date", { date: data.date }), marginX, y + 16);
  if (data.validUntil) {
    doc.text(t("documents.quote.validUntil", { date: data.validUntil }), marginX, y + 22);
  }
  if (data.customerName) {
    doc.text(t("documents.common.customer", { name: data.customerName }), marginX, y + 28);
  }

  y += 38;
  const colWidth = (210 - marginX * 2) / 4;
  doc.setFont("helvetica", "bold");
  doc.text(t("documents.quote.columnArticle"), marginX, y);
  doc.text(t("documents.quote.columnQty"), marginX + colWidth * 2, y);
  doc.text(t("documents.quote.columnUnitPrice"), marginX + colWidth * 2.7, y);
  doc.text(t("documents.quote.columnTotal"), marginX + colWidth * 3.5, y);
  y += 6;
  doc.setFont("helvetica", "normal");

  // Retourne à la ligne la description (seule colonne en texte libre, donc
  // seule à risquer de déborder sur la colonne Qté) — sans ça, une
  // description plus longue que la largeur de sa colonne se superpose
  // visuellement au reste de la ligne, jsPDF ne le faisant jamais de
  // lui-même.
  const descriptionWidth = colWidth * 2 - 4;
  for (const line of data.lines) {
    const descriptionLines = doc.splitTextToSize(line.description, descriptionWidth) as string[];
    const rowHeight = Math.max(1, descriptionLines.length) * 6;
    if (y + rowHeight > 270) {
      doc.addPage();
      y = 20;
    }
    doc.text(descriptionLines, marginX, y);
    doc.text(String(line.quantity), marginX + colWidth * 2, y);
    doc.text(line.unitPrice.toFixed(0), marginX + colWidth * 2.7, y);
    doc.text(line.total.toFixed(0), marginX + colWidth * 3.5, y);
    y += rowHeight;
  }

  y += 6;
  doc.text(t("documents.common.subtotal", { amount: data.subtotal.toFixed(0) }), marginX + colWidth * 2.7, y);
  y += 6;
  if (data.tax > 0) {
    doc.text(t("documents.common.tax", { amount: data.tax.toFixed(0) }), marginX + colWidth * 2.7, y);
    y += 6;
  }
  doc.setFont("helvetica", "bold");
  doc.text(t("documents.common.total", { amount: data.total.toFixed(0) }), marginX + colWidth * 2.7, y);

  return doc.output("blob");
}
