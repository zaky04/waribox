import { t } from "@gestion-boutique/i18n";
import { jsPDF } from "jspdf";
import { padLine, type ReceiptData } from "./receipt";
import type { ServiceOrderTicketData } from "./serviceTicket";

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
// Largeur approximative d'un caractère Courier, en mm par point de police
// (0.6 × la taille en pt = largeur en pt, converti en mm à 72pt/pouce). Sert
// à calculer la taille de police qui fait tenir exactement `columns`
// caractères dans la largeur utile du ticket — jsPDF ne fait aucun retour à
// la ligne automatique, contrairement à une imprimante ESC/POS physique qui
// coupe naturellement au nombre de colonnes de sa police Font A.
const COURIER_MM_PER_PT = 0.6 * (25.4 / 72);

// Découpe un texte libre (nom de commerce, phrase de pied de ticket...) en
// plusieurs lignes d'au plus `columns` caractères, sur des limites de mots —
// sans ça, toute phrase plus longue que le ticket est physiquement coupée à
// l'impression PDF (elle continuerait hors-page), alors que la même phrase
// s'enroule normalement sur une vraie imprimante thermique. Un mot seul plus
// long que `columns` est laissé tel quel plutôt que d'être tronqué au milieu.
function wrapText(text: string, columns: number): string[] {
  if (text.length <= columns) return [text];
  const words = text.split(" ");
  const result: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > columns && current) {
      result.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) result.push(current);
  return result;
}

function pushWrapped(lines: PdfLine[], text: string, columns: number, opts: Omit<PdfLine, "text"> = {}) {
  for (const wrapped of wrapText(text, columns)) {
    lines.push({ text: wrapped, ...opts });
  }
}

function renderLines(lines: PdfLine[], widthMm: number, columns: number, logoDataUrl?: string): Blob {
  const heightMm = MARGIN_MM * 2 + lines.length * LINE_HEIGHT_MM + (logoDataUrl ? LOGO_HEIGHT_MM + 2 : 0);
  const doc = new jsPDF({ unit: "mm", format: [widthMm, heightMm] });
  // Taille de police calculée pour que `columns` caractères Courier tiennent
  // dans la largeur utile — évite que les lignes pleines (séparateurs,
  // articles alignés) débordent de la page (vu en pratique : 9pt fixe
  // dépassait la largeur utile de 20 à 30% selon le préréglage 58/80mm).
  // Plafonnée à 9pt pour ne pas non plus grossir inutilement sur un réglage
  // à faible nombre de colonnes.
  const usableWidthMm = widthMm - MARGIN_MM * 2;
  const fontSize = Math.min(9, usableWidthMm / columns / COURIER_MM_PER_PT);
  doc.setFontSize(fontSize);

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

  pushWrapped(lines, data.businessName ?? "WariBox", columns, { align: "center", bold: true });
  if (data.businessAddress) pushWrapped(lines, data.businessAddress, columns, { align: "center" });
  if (data.businessPhone) {
    pushWrapped(lines, t("documents.common.phone", { phone: data.businessPhone }), columns, { align: "center" });
  }
  if (data.businessEmail) pushWrapped(lines, data.businessEmail, columns, { align: "center" });
  lines.push({ text: t("documents.common.ticketLabel", { number: data.saleNumber }), align: "center" });
  lines.push({ text: data.date, align: "center" });
  pushWrapped(lines, t("documents.receipt.cashier", { name: data.cashierName }), columns, { align: "center" });
  if (data.customerName) {
    pushWrapped(lines, t("documents.common.customer", { name: data.customerName }), columns, { align: "center" });
  }

  lines.push({ text: separator });
  for (const line of data.lines) {
    const left = `${line.quantity} x ${line.label}`;
    const right = line.total.toFixed(0);
    const combined = padLine(left, right, columns);
    if (combined) {
      lines.push({ text: combined });
    } else {
      pushWrapped(lines, left, columns);
      lines.push({ text: right, align: "right" });
    }
  }
  lines.push({ text: separator });

  lines.push({ text: t("documents.common.subtotal", { amount: data.subtotal.toFixed(0) }) });
  if (data.discount > 0) lines.push({ text: t("documents.common.discount", { amount: data.discount.toFixed(0) }) });
  if (data.tax > 0) lines.push({ text: t("documents.common.tax", { amount: data.tax.toFixed(0) }) });
  lines.push({ text: t("documents.common.total", { amount: data.total.toFixed(0) }), bold: true });
  pushWrapped(
    lines,
    t("documents.receipt.payment", {
      method: t(`sales.paymentMethods.${data.paymentMethod}`, { defaultValue: data.paymentMethod }),
      amount: data.amountPaid.toFixed(0),
    }),
    columns,
  );
  lines.push({ text: "" });
  lines.push({ text: t("documents.receipt.thanks"), align: "center" });

  return renderLines(lines, widthMm, columns, data.logoDataUrl);
}

// Copie PDF d'un bon de dépôt (ticket de service) — même mise en page
// logique que buildServiceOrderTicket (ESC/POS).
export function buildServiceOrderTicketPdf(data: ServiceOrderTicketData): Blob {
  const columns = data.columns ?? 32;
  const widthMm = widthMmFromColumns(columns);
  const separator = "-".repeat(columns);
  const lines: PdfLine[] = [];

  pushWrapped(lines, data.businessName ?? "WariBox", columns, { align: "center", bold: true });
  if (data.businessAddress) pushWrapped(lines, data.businessAddress, columns, { align: "center" });
  if (data.businessPhone) {
    pushWrapped(lines, t("documents.common.phone", { phone: data.businessPhone }), columns, { align: "center" });
  }
  if (data.businessEmail) pushWrapped(lines, data.businessEmail, columns, { align: "center" });
  lines.push({ text: t("documents.serviceTicket.title"), align: "center", bold: true });
  lines.push({ text: t("documents.common.ticketLabel", { number: data.orderNumber }), align: "center" });
  lines.push({ text: data.date, align: "center" });
  if (data.customerName) {
    pushWrapped(lines, t("documents.common.customer", { name: data.customerName }), columns, { align: "center" });
  }
  if (data.customerPhone) {
    pushWrapped(lines, t("documents.serviceTicket.customerPhone", { phone: data.customerPhone }), columns, {
      align: "center",
    });
  }
  if (data.showPromisedDate && data.promisedDate) {
    lines.push({ text: t("documents.serviceTicket.promisedDate", { date: data.promisedDate }), align: "center" });
  }

  lines.push({ text: separator });
  for (const line of data.lines) {
    const left = `${line.quantity} x ${line.description}`;
    const right = line.total.toFixed(0);
    const combined = padLine(left, right, columns);
    if (combined) {
      lines.push({ text: combined });
    } else {
      pushWrapped(lines, left, columns);
      lines.push({ text: right, align: "right" });
    }
  }
  lines.push({ text: separator });

  lines.push({ text: t("documents.common.subtotal", { amount: data.subtotal.toFixed(0) }) });
  if (data.tax > 0) lines.push({ text: t("documents.common.tax", { amount: data.tax.toFixed(0) }) });
  lines.push({ text: t("documents.common.total", { amount: data.total.toFixed(0) }), bold: true });
  lines.push({ text: t("documents.serviceTicket.paid", { amount: data.amountPaid.toFixed(0) }) });
  const balance = data.total - data.amountPaid;
  if (balance > 0) {
    lines.push({ text: t("documents.serviceTicket.balanceDue", { amount: balance.toFixed(0) }), bold: true });
  }
  lines.push({ text: "" });
  pushWrapped(lines, t("documents.serviceTicket.keepTicket"), columns, { align: "center" });

  return renderLines(lines, widthMm, columns, data.logoDataUrl);
}
