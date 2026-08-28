import { t } from "@gestion-boutique/i18n";

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

// Version texte du ticket, pour l'envoi WhatsApp — l'app étant 100% locale
// sans serveur, il n'existe pas de page de reçu à héberger : un message
// pré-rempli est la seule forme de "reçu numérique" possible ici.
// Appelle `t()` directement (import depuis @gestion-boutique/i18n) plutôt que
// de recevoir la langue/fonction `t` en paramètre — même principe que les
// messages d'erreur de packages/core, voir CLAUDE.md.
export function buildReceiptWhatsAppMessage(data: WhatsAppReceiptData): string {
  const business = data.businessName ?? t("whatsapp.defaultBusinessName");
  const lines = [
    t("whatsapp.receipt.header", { business, saleNumber: data.saleNumber }),
    data.date,
    "",
    ...data.lines.map((line) => `${line.quantity} x ${line.label} — ${line.total.toFixed(0)}`),
    "",
    t("whatsapp.receipt.subtotal", { amount: data.subtotal.toFixed(0) }),
  ];
  if (data.discount > 0) lines.push(t("whatsapp.receipt.discount", { amount: data.discount.toFixed(0) }));
  lines.push(t("whatsapp.receipt.total", { amount: data.total.toFixed(0) }));
  lines.push(
    t("whatsapp.receipt.paid", {
      method: t(`sales.paymentMethods.${data.paymentMethod}`, { defaultValue: data.paymentMethod }),
      amount: data.amountPaid.toFixed(0),
    }),
  );
  lines.push("", t("whatsapp.receipt.thanks"));
  return lines.join("\n");
}
