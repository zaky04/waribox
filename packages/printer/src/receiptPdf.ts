import { jsPDF } from "jspdf";
import { padLine, type ReceiptData } from "./receipt";
import type { ServiceOrderTicketData } from "./serviceTicket";

const PAYMENT_LABELS: Record<string, string> = {
  cash: "Espèces",
  card: "Carte",
  mobile_money: "Mobile Money",
  credit: "Crédit",
};

// 58mm/80mm sont les deux presets réels du secteur (voir ReceiptData.columns)
// — un réglage personnalisé est simplement rattaché au plus proche des deux,
// cette dimension ne sert qu'à donner au PDF un rendu "ticket" fidèle, pas à
// reproduire une largeur de rouleau exacte.
function widthMmFromColumns(columns: number): number {
  return columns <= 32 ? 58 : 80;
}

interface PdfLine {
  text: string;
  align?: "left" | "center" | "right";
  bold?: boolean;
}

const MARGIN_MM = 4;
const LINE_HEIGHT_MM = 5;
const LOGO_HEIGHT_MM = 16;

function renderLines(lines: PdfLine[], widthMm: number, logoDataUrl?: string): Blob {
  const heightMm = MARGIN_MM * 2 + lines.length * LINE_HEIGHT_MM + (logoDataUrl ? LOGO_HEIGHT_MM + 2 : 0);
  const doc = new jsPDF({ unit: "mm", format: [widthMm, heightMm] });
  doc.setFontSize(9);

  let y = MARGIN_MM + 3;

  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, widthMm / 2 - LOGO_HEIGHT_MM / 2, y, LOGO_HEIGHT_MM, LOGO_HEIGHT_MM);
      y += LOGO_HEIGHT_MM + 2;
    } catch {
      // Logo illisible (format non supporté par jsPDF) — le PDF reste
      // utilisable sans image plutôt que d'échouer toute la génération.
    }
  }

  for (const line of lines) {
    doc.setFont("courier", line.bold ? "bold" : "normal");
    const align = line.align ?? "left";
    const x = align === "center" ? widthMm / 2 : align === "right" ? widthMm - MARGIN_MM : MARGIN_MM;
    doc.text(line.text, x, y, { align });
    y += LINE_HEIGHT_MM;
  }

  return doc.output("blob");
}

// Copie PDF d'un ticket de caisse — même mise en page logique que
// buildReceipt (ESC/POS), pour que la version "papier" et la version
// enregistrée se correspondent visuellement.
export function buildReceiptPdf(data: ReceiptData): Blob {
  const columns = data.columns ?? 32;
  const widthMm = widthMmFromColumns(columns);
  const separator = "-".repeat(columns);
  const lines: PdfLine[] = [];

  lines.push({ text: data.businessName ?? "WariBox", align: "center", bold: true });
  if (data.businessAddress) lines.push({ text: data.businessAddress, align: "center" });
  if (data.businessPhone) lines.push({ text: `Tél : ${data.businessPhone}`, align: "center" });
  if (data.businessEmail) lines.push({ text: data.businessEmail, align: "center" });
  lines.push({ text: `Ticket ${data.saleNumber}`, align: "center" });
  lines.push({ text: data.date, align: "center" });
  lines.push({ text: `Caissier : ${data.cashierName}`, align: "center" });
  if (data.customerName) lines.push({ text: `Client : ${data.customerName}`, align: "center" });

  lines.push({ text: separator });
  for (const line of data.lines) {
    const left = `${line.quantity} x ${line.label}`;
    const right = line.total.toFixed(0);
    const combined = padLine(left, right, columns);
    if (combined) {
      lines.push({ text: combined });
    } else {
      lines.push({ text: left });
      lines.push({ text: right, align: "right" });
    }
  }
  lines.push({ text: separator });

  lines.push({ text: `Sous-total : ${data.subtotal.toFixed(0)}` });
  if (data.discount > 0) lines.push({ text: `Remise : -${data.discount.toFixed(0)}` });
  if (data.tax > 0) lines.push({ text: `Taxe : ${data.tax.toFixed(0)}` });
  lines.push({ text: `TOTAL : ${data.total.toFixed(0)}`, bold: true });
  lines.push({
    text: `Paiement (${PAYMENT_LABELS[data.paymentMethod] ?? data.paymentMethod}) : ${data.amountPaid.toFixed(0)}`,
  });
  lines.push({ text: "" });
  lines.push({ text: "Merci de votre visite !", align: "center" });

  return renderLines(lines, widthMm, data.logoDataUrl);
}

// Copie PDF d'un bon de dépôt (ticket de service) — même mise en page
// logique que buildServiceOrderTicket (ESC/POS).
export function buildServiceOrderTicketPdf(data: ServiceOrderTicketData): Blob {
  const columns = data.columns ?? 32;
  const widthMm = widthMmFromColumns(columns);
  const separator = "-".repeat(columns);
  const lines: PdfLine[] = [];

  lines.push({ text: data.businessName ?? "WariBox", align: "center", bold: true });
  if (data.businessAddress) lines.push({ text: data.businessAddress, align: "center" });
  if (data.businessPhone) lines.push({ text: `Tél : ${data.businessPhone}`, align: "center" });
  if (data.businessEmail) lines.push({ text: data.businessEmail, align: "center" });
  lines.push({ text: "BON DE DEPOT", align: "center", bold: true });
  lines.push({ text: `Ticket ${data.orderNumber}`, align: "center" });
  lines.push({ text: data.date, align: "center" });
  if (data.customerName) lines.push({ text: `Client : ${data.customerName}`, align: "center" });
  if (data.customerPhone) lines.push({ text: `Tél client : ${data.customerPhone}`, align: "center" });
  if (data.showPromisedDate && data.promisedDate) {
    lines.push({ text: `Retrait prevu : ${data.promisedDate}`, align: "center" });
  }

  lines.push({ text: separator });
  for (const line of data.lines) {
    const left = `${line.quantity} x ${line.description}`;
    const right = line.total.toFixed(0);
    const combined = padLine(left, right, columns);
    if (combined) {
      lines.push({ text: combined });
    } else {
      lines.push({ text: left });
      lines.push({ text: right, align: "right" });
    }
  }
  lines.push({ text: separator });

  lines.push({ text: `Sous-total : ${data.subtotal.toFixed(0)}` });
  if (data.tax > 0) lines.push({ text: `Taxe : ${data.tax.toFixed(0)}` });
  lines.push({ text: `TOTAL : ${data.total.toFixed(0)}`, bold: true });
  lines.push({ text: `Paye : ${data.amountPaid.toFixed(0)}` });
  const balance = data.total - data.amountPaid;
  if (balance > 0) {
    lines.push({ text: `SOLDE DU : ${balance.toFixed(0)}`, bold: true });
  }
  lines.push({ text: "" });
  lines.push({ text: "Conservez ce ticket, il vous sera demande au retrait.", align: "center" });

  return renderLines(lines, widthMm, data.logoDataUrl);
}
