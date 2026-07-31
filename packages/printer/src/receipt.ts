import { EscPosBuilder } from "./escpos";
import { rasterizeLogo } from "./logo";

export interface ReceiptLine {
  label: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface ReceiptData {
  businessName?: string;
  businessAddress?: string;
  businessPhone?: string;
  businessEmail?: string;
  logoDataUrl?: string;
  // Largeur du ticket en caractères (Font A) — 32 = 58mm, 48 = 80mm. Défaut
  // 32 si absent, pour rester compatible avec les tickets déjà construits
  // avant l'introduction de ce réglage.
  columns?: number;
  saleNumber: string;
  date: string;
  cashierName: string;
  customerName?: string;
  lines: ReceiptLine[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paymentMethod: string;
  amountPaid: number;
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: "Espèces",
  card: "Carte",
  mobile_money: "Mobile Money",
  credit: "Crédit",
};

// Points ESC/POS par caractère en Font A — ratio standard qui correspond aux
// deux presets du secteur : 32 col -> 384 pts (58mm), 48 col -> 576 pts (80mm).
export const DOTS_PER_COLUMN = 12;
export const MAX_LOGO_HEIGHT_DOTS = 200;

// Assemble une ligne "libellé ... montant" tenant sur `width` caractères, ou
// `null` si le libellé est trop long pour tenir sur une seule ligne — dans ce
// cas l'appelant se replie sur un affichage libellé/montant sur deux lignes.
export function padLine(left: string, right: string, width: number): string | null {
  if (left.length + right.length + 1 > width) return null;
  return left + " ".repeat(width - left.length - right.length) + right;
}

export async function buildReceipt(data: ReceiptData): Promise<Uint8Array> {
  const columns = data.columns ?? 32;
  const separator = "-".repeat(columns);
  const builder = new EscPosBuilder().init();

  builder.align("center");

  if (data.logoDataUrl) {
    try {
      const bitmap = await rasterizeLogo(data.logoDataUrl, columns * DOTS_PER_COLUMN, MAX_LOGO_HEIGHT_DOTS);
      builder.image(bitmap).newline();
    } catch {
      // Logo illisible ou rendu impossible (ex. hors navigateur) — le ticket
      // reste utilisable sans image plutôt que d'échouer toute l'impression.
    }
  }

  builder.bold(true).doubleHeight(true);
  builder.text(data.businessName ?? "WariBox").newline();
  builder.doubleHeight(false).bold(false);
  if (data.businessAddress) builder.text(data.businessAddress).newline();
  if (data.businessPhone) builder.text(`Tél : ${data.businessPhone}`).newline();
  if (data.businessEmail) builder.text(data.businessEmail).newline();

  builder.text(`Ticket ${data.saleNumber}`).newline();
  builder.text(data.date).newline();
  builder.text(`Caissier : ${data.cashierName}`).newline();
  if (data.customerName) {
    builder.text(`Client : ${data.customerName}`).newline();
  }

  builder.align("left");
  builder.text(separator).newline();

  for (const line of data.lines) {
    const left = `${line.quantity} x ${line.label}`;
    const right = line.total.toFixed(0);
    const combined = padLine(left, right, columns);
    if (combined) {
      builder.text(combined).newline();
    } else {
      builder.text(left).newline();
      builder.align("right").text(right).newline();
      builder.align("left");
    }
  }

  builder.text(separator).newline();
  builder.text(`Sous-total : ${data.subtotal.toFixed(0)}`).newline();
  if (data.discount > 0) {
    builder.text(`Remise : -${data.discount.toFixed(0)}`).newline();
  }
  if (data.tax > 0) {
    builder.text(`Taxe : ${data.tax.toFixed(0)}`).newline();
  }
  builder.bold(true).text(`TOTAL : ${data.total.toFixed(0)}`).newline().bold(false);
  builder
    .text(`Paiement (${PAYMENT_LABELS[data.paymentMethod] ?? data.paymentMethod}) : ${data.amountPaid.toFixed(0)}`)
    .newline();

  builder.align("center").newline(2).text("Merci de votre visite !").newline(3);
  builder.cut();

  return builder.build();
}
