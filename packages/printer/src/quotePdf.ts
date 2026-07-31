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
    doc.text(`Tél : ${data.businessPhone}`, marginX, y);
    y += 6;
  }
  if (data.businessEmail) {
    doc.text(data.businessEmail, marginX, y);
    y += 6;
  }

  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text(`Devis ${data.quoteNumber}`, marginX, y + 8);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Date : ${data.date}`, marginX, y + 16);
  if (data.validUntil) {
    doc.text(`Valable jusqu'au : ${data.validUntil}`, marginX, y + 22);
  }
  if (data.customerName) {
    doc.text(`Client : ${data.customerName}`, marginX, y + 28);
  }

  y += 38;
  const colWidth = (210 - marginX * 2) / 4;
  doc.setFont("helvetica", "bold");
  doc.text("Article", marginX, y);
  doc.text("Qté", marginX + colWidth * 2, y);
  doc.text("Prix unit.", marginX + colWidth * 2.7, y);
  doc.text("Total", marginX + colWidth * 3.5, y);
  y += 6;
  doc.setFont("helvetica", "normal");

  for (const line of data.lines) {
    if (y > 270) {
      doc.addPage();
      y = 20;
    }
    doc.text(line.description, marginX, y);
    doc.text(String(line.quantity), marginX + colWidth * 2, y);
    doc.text(line.unitPrice.toFixed(0), marginX + colWidth * 2.7, y);
    doc.text(line.total.toFixed(0), marginX + colWidth * 3.5, y);
    y += 6;
  }

  y += 6;
  doc.text(`Sous-total : ${data.subtotal.toFixed(0)}`, marginX + colWidth * 2.7, y);
  y += 6;
  if (data.tax > 0) {
    doc.text(`Taxe : ${data.tax.toFixed(0)}`, marginX + colWidth * 2.7, y);
    y += 6;
  }
  doc.setFont("helvetica", "bold");
  doc.text(`TOTAL : ${data.total.toFixed(0)}`, marginX + colWidth * 2.7, y);

  return doc.output("blob");
}
