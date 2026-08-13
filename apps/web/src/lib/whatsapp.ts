// Lien "cliquer pour envoyer" wa.me — n'exige aucun compte/API WhatsApp
// Business, ouvre WhatsApp (app ou web) avec le message pré-rempli, un clic
// suffit ensuite pour l'envoyer.
export function buildWhatsAppLink(phone: string, countryCode: string | null | undefined, message: string): string {
  const digits = phone.replace(/\D/g, "");
  const code = (countryCode ?? "").replace(/\D/g, "");
  const withCountry = code && digits.startsWith(code) ? digits : `${code}${digits.replace(/^0+/, "")}`;
  return `https://wa.me/${withCountry}?text=${encodeURIComponent(message)}`;
}

export interface WhatsAppReceiptLine {
  label: string;
  quantity: number;
  total: number;
}

export interface WhatsAppReceiptData {
  businessName?: string;
  saleNumber: string;
  date: string;
  lines: WhatsAppReceiptLine[];
  subtotal: number;
  discount: number;
  total: number;
  paymentMethod: string;
  amountPaid: number;
}

const WHATSAPP_PAYMENT_LABELS: Record<string, string> = {
  cash: "Espèces",
  card: "Carte",
  mobile_money: "Mobile Money",
  credit: "Crédit",
};

// Version texte du ticket, pour l'envoi WhatsApp — l'app étant 100% locale
// sans serveur, il n'existe pas de page de reçu à héberger : un message
// pré-rempli est la seule forme de "reçu numérique" possible ici.
export function buildReceiptWhatsAppMessage(data: WhatsAppReceiptData): string {
  const lines = [
    `🧾 *${data.businessName ?? "WariBox"}* — Ticket ${data.saleNumber}`,
    data.date,
    "",
    ...data.lines.map((line) => `${line.quantity} x ${line.label} — ${line.total.toFixed(0)}`),
    "",
    `Sous-total : ${data.subtotal.toFixed(0)}`,
  ];
  if (data.discount > 0) lines.push(`Remise : -${data.discount.toFixed(0)}`);
  lines.push(`*Total : ${data.total.toFixed(0)}*`);
  lines.push(
    `Payé (${WHATSAPP_PAYMENT_LABELS[data.paymentMethod] ?? data.paymentMethod}) : ${data.amountPaid.toFixed(0)}`,
  );
  lines.push("", "Merci de votre visite !");
  return lines.join("\n");
}
