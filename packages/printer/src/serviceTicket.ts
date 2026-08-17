import { t } from "@gestion-boutique/i18n";
import { DOTS_PER_COLUMN, MAX_LOGO_HEIGHT_DOTS, padLine } from "./receipt";
import { EscPosBuilder } from "./escpos";
import { rasterizeLogo } from "./logo";

export interface ServiceOrderTicketLine {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface ServiceOrderTicketData {
  businessName?: string;
  businessAddress?: string;
  businessPhone?: string;
  businessEmail?: string;
  logoDataUrl?: string;
  columns?: number;
  orderNumber: string;
  date: string;
  customerName?: string;
  customerPhone?: string;
  lines: ServiceOrderTicketLine[];
  subtotal: number;
  tax: number;
  total: number;
  amountPaid: number;
  promisedDate?: string;
  // Réglage business_settings.print_promised_date_on_ticket — l'appelant
  // décide s'il transmet promisedDate ou non, mais on le documente ici pour
  // que ce ne soit pas oublié au site d'appel.
  showPromisedDate: boolean;
}

export async function buildServiceOrderTicket(data: ServiceOrderTicketData): Promise<Uint8Array> {
  const columns = data.columns ?? 32;
  const separator = "-".repeat(columns);
  const builder = new EscPosBuilder().init();

  builder.align("center");

  if (data.logoDataUrl) {
    try {
      const bitmap = await rasterizeLogo(data.logoDataUrl, columns * DOTS_PER_COLUMN, MAX_LOGO_HEIGHT_DOTS);
      builder.image(bitmap).newline();
    } catch {
      // Logo illisible ou rendu impossible — le ticket reste utilisable sans
      // image plutôt que d'échouer toute l'impression.
    }
  }

  builder.bold(true).doubleHeight(true);
  builder.text(data.businessName ?? "WariBox").newline();
  builder.doubleHeight(false).bold(false);
  if (data.businessAddress) builder.text(data.businessAddress).newline();
  if (data.businessPhone) builder.text(t("documents.common.phone", { phone: data.businessPhone })).newline();
  if (data.businessEmail) builder.text(data.businessEmail).newline();

  builder.bold(true).text(t("documents.serviceTicket.title")).newline().bold(false);
  builder.text(t("documents.common.ticketLabel", { number: data.orderNumber })).newline();
  builder.text(data.date).newline();
  if (data.customerName) builder.text(t("documents.common.customer", { name: data.customerName })).newline();
  if (data.customerPhone) {
    builder.text(t("documents.serviceTicket.customerPhone", { phone: data.customerPhone })).newline();
  }
  if (data.showPromisedDate && data.promisedDate) {
    builder.text(t("documents.serviceTicket.promisedDate", { date: data.promisedDate })).newline();
  }

  builder.align("left");
  builder.text(separator).newline();

  for (const line of data.lines) {
    const left = `${line.quantity} x ${line.description}`;
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
  builder.text(t("documents.common.subtotal", { amount: data.subtotal.toFixed(0) })).newline();
  if (data.tax > 0) {
    builder.text(t("documents.common.tax", { amount: data.tax.toFixed(0) })).newline();
  }
  builder.bold(true).text(t("documents.common.total", { amount: data.total.toFixed(0) })).newline().bold(false);
  builder.text(t("documents.serviceTicket.paid", { amount: data.amountPaid.toFixed(0) })).newline();
  const balance = data.total - data.amountPaid;
  if (balance > 0) {
    builder
      .bold(true)
      .text(t("documents.serviceTicket.balanceDue", { amount: balance.toFixed(0) }))
      .newline()
      .bold(false);
  }

  builder
    .align("center")
    .newline(2)
    .text(t("documents.serviceTicket.keepTicket"))
    .newline(3);
  builder.cut();

  return builder.build();
}
