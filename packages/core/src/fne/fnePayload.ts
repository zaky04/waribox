import type { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import type { FneInvoiceItem, FneInvoicePayload, FneTaxCode } from "./fneTypes";

// Le montant de remise de WariBox est un MONTANT ABSOLU (item et vente),
// alors que la FNE attend un POURCENTAGE 0-100 — voir CLAUDE.md. Convertit
// et plafonne à 100 (une remise mal saisie ne doit jamais faire échouer la
// certification pour une raison aussi évitable qu'un dépassement d'arrondi).
function toDiscountPercent(discountAmount: number, baseAmount: number): number | undefined {
  if (discountAmount <= 0 || baseAmount <= 0) return undefined;
  return Math.min(100, (discountAmount / baseAmount) * 100);
}

// La FNE attend un CODE de taxe (TVA/TVAB/TVAC/TVAD), WariBox un taux
// numérique par ligne — mapping best-effort, jamais vérifié contre la vraie
// API (voir CLAUDE.md). 0% est mappé sur TVAC (exonération conventionnelle)
// par défaut faute de moyen de distinguer TVAC/TVAD depuis un simple taux —
// à ajuster ici (fonction isolée) si la vraie API se comporte autrement.
export function mapTaxRateToFneCode(taxRate: number): FneTaxCode {
  if (taxRate >= 18) return "TVA";
  if (taxRate >= 9) return "TVAB";
  return "TVAC";
}

export interface FneCustomerLike {
  fullName: string;
  phone: string | null;
  email: string | null;
}

export interface FneBusinessSettingsLike {
  phone: string | null;
  email: string | null;
  fneEstablishment: string | null;
  fnePointOfSale: string | null;
}

/**
 * Construit le payload de certification FNE à partir d'une vente déjà
 * enregistrée. Pas d'appel réseau ici (voir apps/web/src/features/fne pour
 * l'appel HTTP réel) — même séparation que packages/core/src/sync/syncEvents.ts
 * vs apps/web/src/features/network.
 *
 * Repli client de passage : la FNE exige clientPhone/clientEmail non vides
 * même en B2C, alors qu'une vente WariBox peut être entièrement anonyme
 * (voir CustomersService.findOrCreateCustomerByName, qui ne collecte jamais
 * ni téléphone ni email) — on utilise alors le téléphone/email de
 * l'ENTREPRISE elle-même (business_settings, quasi toujours renseignés) au
 * lieu d'inventer une donnée. Voir CLAUDE.md pour cette décision.
 */
export function buildFneInvoicePayload(
  sale: typeof schema.sales.$inferSelect,
  items: Array<typeof schema.saleItems.$inferSelect>,
  customer: FneCustomerLike | null,
  businessSettings: FneBusinessSettingsLike,
): FneInvoicePayload {
  const fneItems: FneInvoiceItem[] = items.map((item) => ({
    description: `Article #${item.variantId}`,
    quantity: item.quantity,
    amount: item.unitPrice,
    taxes: [mapTaxRateToFneCode(item.taxRate)],
    discount: toDiscountPercent(item.discount, item.quantity * item.unitPrice),
  }));

  const itemsTotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

  return {
    invoiceType: "sale",
    // WariBox n'a pas de méthode de paiement par opérateur mobile money
    // distincte — "cash" par défaut pour une vente à crédit/partielle sans
    // paiement enregistré, cohérent avec le comportement déjà en place pour
    // l'export SYSCOHADA (voir SyscohadaService.resolvePaymentMethod).
    paymentMethod: "cash",
    template: "B2C",
    pointOfSale: businessSettings.fnePointOfSale ?? "",
    establishment: businessSettings.fneEstablishment ?? "",
    clientCompanyName: customer?.fullName ?? t("syscohadaLabels.walkInCustomer"),
    clientPhone: customer?.phone ?? businessSettings.phone ?? "",
    clientEmail: customer?.email ?? businessSettings.email ?? "",
    isRne: false,
    items: fneItems,
    discount: toDiscountPercent(sale.discount, itemsTotal),
    foreignCurrency: "",
    foreignCurrencyRate: 0,
  };
}
