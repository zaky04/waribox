import { t } from "@gestion-boutique/i18n";

// Validation des montants et quantités à l'entrée des services. L'écran filtre
// déjà ces cas, mais un service reste appelable directement (autre appareil,
// événement rejoué, bogue d'écran) : sans ces contrôles, une quantité nulle
// créait une vente à 0, et une quantité négative pouvait ajouter du stock via
// une « vente ».

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function assertValidAmount(amount: number, options: { allowZero?: boolean } = {}): void {
  if (!isNumber(amount) || amount < 0 || (amount === 0 && !options.allowZero)) throw new Error(t("coreErrors.common.invalidAmount"));
}

export function assertValidTaxRate(taxRate: number | null | undefined): void {
  if (taxRate == null) return;
  if (!isNumber(taxRate) || taxRate < 0 || taxRate > 100) throw new Error(t("coreErrors.common.invalidTaxRate"));
}

export interface LineLike {
  quantity: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number | null;
}

export function assertValidLines(lines: LineLike[]): void {
  for (const line of lines) {
    if (!isNumber(line.quantity) || line.quantity <= 0) throw new Error(t("coreErrors.common.invalidQuantity"));
    if (!isNumber(line.unitPrice) || line.unitPrice < 0) throw new Error(t("coreErrors.common.invalidPrice"));
    const discount = line.discount ?? 0;
    // Petite tolérance : l'arrondi d'une remise saisie en centimes.
    if (!isNumber(discount) || discount < 0 || discount > line.quantity * line.unitPrice + 0.005) throw new Error(t("coreErrors.common.invalidDiscount"));
    assertValidTaxRate(line.taxRate);
  }
}
