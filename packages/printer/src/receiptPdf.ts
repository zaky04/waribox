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
// Marge de sécurité appliquée à la décision de retour à la ligne (90% de la
// largeur utile plutôt que 100%) — filet de sécurité contre un écart de
// mesure entre la génération et le rendu final (vu en pratique : un texte
// mesuré comme tenant tout juste s'est retrouvé visiblement débordant à
// l'usage réel, voir journal CLAUDE.md). Une marge généreuse coûte au pire
// une ligne de plus de temps en temps, largement préférable à un texte
// coupé.
const WRAP_SAFETY_MARGIN = 0.9;

function computeFontSize(usableWidthMm: number, columns: number): number {
  // Plafonnée à 9pt pour ne pas grossir inutilement sur un réglage à faible
  // nombre de colonnes (vu en pratique : 9pt fixe dépassait la largeur utile
  // de 20 à 30% selon le préréglage 58/80mm, d'où ce calcul dynamique).
  return Math.min(9, usableWidthMm / columns / COURIER_MM_PER_PT);
}

// Découpe un texte libre (nom de commerce, phrase de pied de ticket...) en
// plusieurs lignes qui tiennent chacune dans `maxWidthMm`, mesuré avec la
// vraie métrique de police de jsPDF (`measure`, un `doc.getTextWidth` déjà
// configuré à la bonne police/taille) plutôt qu'une estimation par nombre de
// caractères.
//
// Historique : la version précédente comparait `text.length` à `columns`
// (le nombre de caractères cible de la ligne), en supposant que la taille de
// police calculée par `computeFontSize` fait toujours tenir exactement
// `columns` caractères dans `usableWidthMm` — vrai en théorie (la ligne
// séparatrice, toujours exactement `columns` caractères, le confirme), mais
// un texte libre de test.length <= columns (ex. 53 caractères pour une
// configuration à 53 colonnes ou plus) s'est avéré déborder réellement à
// l'usage (voir journal CLAUDE.md) — l'estimation par caractères ne protège
// pas contre un écart de mesure, aussi faible soit-il, entre le calcul fait
// ici et le rendu réel. Mesurer directement avec `doc.getTextWidth` supprime
// cette hypothèse : la décision de couper une ligne se base sur la même
// métrique que celle utilisée par jsPDF pour positionner le texte.
function wrapText(measure: (text: string) => number, text: string, maxWidthMm: number): string[] {
  if (measure(text) <= maxWidthMm) return [text];
  const words = text.split(" ");
  const result: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) > maxWidthMm && current) {
      result.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) result.push(current);
  return result;
}

function pushWrapped(
  lines: PdfLine[],
  measure: (text: string) => number,
  text: string,
  maxWidthMm: number,
  opts: Omit<PdfLine, "text"> = {},
) {
  for (const wrapped of wrapText(measure, text, maxWidthMm)) {
    lines.push({ text: wrapped, ...opts });
  }
}

// Crée une fonction de mesure de largeur (mm) pour du texte Courier normal à
// la taille de police calculée pour `columns` — un document jsPDF jetable,
// jamais rendu, seulement utilisé pour ses métriques de police via
// `getTextWidth`. Le gras (Courier-Bold) partage la même largeur par
// caractère que Courier normal (police à chasse fixe), donc une seule
// mesure suffit pour les deux styles.
function createMeasurer(widthMm: number, fontSize: number): (text: string) => number {
  const measureDoc = new jsPDF({ unit: "mm", format: [widthMm, 10] });
  measureDoc.setFont("courier", "normal");
  measureDoc.setFontSize(fontSize);
  return (text: string) => measureDoc.getTextWidth(text);
}

function renderLines(lines: PdfLine[], widthMm: number, columns: number, logoDataUrl?: string): Blob {
  const heightMm = MARGIN_MM * 2 + lines.length * LINE_HEIGHT_MM + (logoDataUrl ? LOGO_HEIGHT_MM + 2 : 0);
  const doc = new jsPDF({ unit: "mm", format: [widthMm, heightMm] });
  const usableWidthMm = widthMm - MARGIN_MM * 2;
  const fontSize = computeFontSize(usableWidthMm, columns);
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
  const usableWidthMm = widthMm - MARGIN_MM * 2;
  const fontSize = computeFontSize(usableWidthMm, columns);
  const measure = createMeasurer(widthMm, fontSize);
  const maxWidthMm = usableWidthMm * WRAP_SAFETY_MARGIN;
  const separator = "-".repeat(columns);
  const lines: PdfLine[] = [];

  pushWrapped(lines, measure, data.businessName ?? "WariBox", maxWidthMm, { align: "center", bold: true });
  if (data.businessAddress) pushWrapped(lines, measure, data.businessAddress, maxWidthMm, { align: "center" });
  if (data.businessPhone) {
    pushWrapped(lines, measure, t("documents.common.phone", { phone: data.businessPhone }), maxWidthMm, {
      align: "center",
    });
  }
  if (data.businessEmail) pushWrapped(lines, measure, data.businessEmail, maxWidthMm, { align: "center" });
  lines.push({ text: t("documents.common.ticketLabel", { number: data.saleNumber }), align: "center" });
  lines.push({ text: data.date, align: "center" });
  pushWrapped(lines, measure, t("documents.receipt.cashier", { name: data.cashierName }), maxWidthMm, {
    align: "center",
  });
  if (data.customerName) {
    pushWrapped(lines, measure, t("documents.common.customer", { name: data.customerName }), maxWidthMm, {
      align: "center",
    });
  }

  lines.push({ text: separator });
  for (const line of data.lines) {
    const left = `${line.quantity} x ${line.label}`;
    const right = line.total.toFixed(0);
    const combined = padLine(left, right, columns);
    if (combined) {
      lines.push({ text: combined });
    } else {
      pushWrapped(lines, measure, left, maxWidthMm);
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
    measure,
    t("documents.receipt.payment", {
      method: t(`sales.paymentMethods.${data.paymentMethod}`, { defaultValue: data.paymentMethod }),
      amount: data.amountPaid.toFixed(0),
    }),
    maxWidthMm,
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
  const usableWidthMm = widthMm - MARGIN_MM * 2;
  const fontSize = computeFontSize(usableWidthMm, columns);
  const measure = createMeasurer(widthMm, fontSize);
  const maxWidthMm = usableWidthMm * WRAP_SAFETY_MARGIN;
  const separator = "-".repeat(columns);
  const lines: PdfLine[] = [];

  pushWrapped(lines, measure, data.businessName ?? "WariBox", maxWidthMm, { align: "center", bold: true });
  if (data.businessAddress) pushWrapped(lines, measure, data.businessAddress, maxWidthMm, { align: "center" });
  if (data.businessPhone) {
    pushWrapped(lines, measure, t("documents.common.phone", { phone: data.businessPhone }), maxWidthMm, {
      align: "center",
    });
  }
  if (data.businessEmail) pushWrapped(lines, measure, data.businessEmail, maxWidthMm, { align: "center" });
  lines.push({ text: t("documents.serviceTicket.title"), align: "center", bold: true });
  lines.push({ text: t("documents.common.ticketLabel", { number: data.orderNumber }), align: "center" });
  lines.push({ text: data.date, align: "center" });
  if (data.customerName) {
    pushWrapped(lines, measure, t("documents.common.customer", { name: data.customerName }), maxWidthMm, {
      align: "center",
    });
  }
  if (data.customerPhone) {
    pushWrapped(
      lines,
      measure,
      t("documents.serviceTicket.customerPhone", { phone: data.customerPhone }),
      maxWidthMm,
      { align: "center" },
    );
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
      pushWrapped(lines, measure, left, maxWidthMm);
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
  pushWrapped(lines, measure, t("documents.serviceTicket.keepTicket"), maxWidthMm, { align: "center" });

  return renderLines(lines, widthMm, columns, data.logoDataUrl);
}
