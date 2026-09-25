import i18next from "i18next";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

// Devise de l'appareil/du commerce — partagée comme la langue : un seul
// setCurrency() met à jour l'affichage de tout le monde (UI, tickets, PDF,
// messages WhatsApp), sans faire transiter la devise dans chaque signature.
// La devise du commerce vit dans business_settings.currency (code ISO) ;
// elle est aussi gardée en localStorage pour que le tout premier rendu, avant
// la lecture des paramètres, soit déjà correct.

export interface CurrencyPreset {
  code: string;
  symbol: string;
  decimals: number;
  symbolPosition: "before" | "after";
  // Séparateur de milliers et de décimales de l'affichage à l'écran.
  thousands: string;
  decimal: string;
  // Zone OHADA/CFA : SYSCOHADA et FNE (Côte d'Ivoire) n'ont de sens que là.
  cfaZone: boolean;
  // Indicatif téléphonique proposé si le champ est vide, TVA courante indicative.
  whatsappCountryCode?: string;
  suggestedVatRate?: number;
  // Libellé du 4e mode de paiement quand "Mobile Money" n'est pas la norme locale.
  mobileMoneyLabel?: { fr: string; en: string };
  // Coupures proposées en boutons rapides à l'encaissement en espèces.
  cashQuickAmounts: number[];
}

const NBSP = " ";

export const CURRENCY_PRESETS: CurrencyPreset[] = [
  { code: "XOF", symbol: "F", decimals: 0, symbolPosition: "after", thousands: NBSP, decimal: ",", cfaZone: true, cashQuickAmounts: [500, 1000, 2000, 5000, 10000, 20000, 50000] },
  { code: "XAF", symbol: "F", decimals: 0, symbolPosition: "after", thousands: NBSP, decimal: ",", cfaZone: true, cashQuickAmounts: [500, 1000, 2000, 5000, 10000, 20000, 50000] },
  {
    code: "NGN",
    cashQuickAmounts: [100, 200, 500, 1000],
    symbol: "₦",
    decimals: 2,
    symbolPosition: "before",
    thousands: ",",
    decimal: ".",
    cfaZone: false,
    whatsappCountryCode: "234",
    suggestedVatRate: 7.5,
    mobileMoneyLabel: { fr: "Virement / mobile", en: "Transfer / mobile" },
  },
  {
    code: "GHS",
    cashQuickAmounts: [5, 10, 20, 50, 100, 200],
    symbol: "₵",
    decimals: 2,
    symbolPosition: "before",
    thousands: ",",
    decimal: ".",
    cfaZone: false,
    whatsappCountryCode: "233",
    suggestedVatRate: 15,
  },
  {
    code: "EUR",
    cashQuickAmounts: [5, 10, 20, 50, 100, 200],
    symbol: "€",
    decimals: 2,
    symbolPosition: "after",
    thousands: NBSP,
    decimal: ",",
    cfaZone: false,
    suggestedVatRate: 20,
    mobileMoneyLabel: { fr: "Virement / autre", en: "Transfer / other" },
  },
  {
    code: "USD",
    cashQuickAmounts: [1, 5, 10, 20, 50, 100],
    symbol: "$",
    decimals: 2,
    symbolPosition: "before",
    thousands: ",",
    decimal: ".",
    cfaZone: false,
    mobileMoneyLabel: { fr: "Virement / autre", en: "Transfer / other" },
  },
  {
    code: "GBP",
    cashQuickAmounts: [5, 10, 20, 50],
    symbol: "£",
    decimals: 2,
    symbolPosition: "before",
    thousands: ",",
    decimal: ".",
    cfaZone: false,
    suggestedVatRate: 20,
    mobileMoneyLabel: { fr: "Virement / autre", en: "Transfer / other" },
  },
];

export const DEFAULT_CURRENCY_CODE = "XOF";
const STORAGE_KEY = "waribox-currency";

function findPreset(code: string | null | undefined): CurrencyPreset {
  return CURRENCY_PRESETS.find((p) => p.code === code) ?? CURRENCY_PRESETS[0]!;
}

export function getCurrencyPreset(code: string | null | undefined): CurrencyPreset {
  return findPreset(code);
}

export function isCfaZoneCurrency(code: string | null | undefined): boolean {
  return findPreset(code).cfaZone;
}

function readStoredCode(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_CURRENCY_CODE;
  } catch {
    return DEFAULT_CURRENCY_CODE;
  }
}

let current: CurrencyPreset = findPreset(readStoredCode());

// Libellé des modes de paiement dont le nom dépend du pays : réécrit les
// entrées de dictionnaire concernées (donc tous les écrans, tickets et messages
// qui passent par t("...paymentMethods.mobile_money") suivent sans changement).
// Les libellés d'origine sont mémorisés au chargement : i18next garde une
// référence vers les objets JSON importés et les modifie sur place.
const PAYMENT_LABEL_KEYS = ["sales.paymentMethods.mobile_money", "expenses.paymentMethods.mobile_money", "purchases.paymentMethods.mobile_money"];

function readLabel(bundle: unknown, key: string): string {
  let node: any = bundle;
  for (const part of key.split(".")) node = node?.[part];
  return typeof node === "string" ? node : "Mobile Money";
}

const ORIGINAL_LABELS: Record<"fr" | "en", Record<string, string>> = {
  fr: Object.fromEntries(PAYMENT_LABEL_KEYS.map((k) => [k, readLabel(fr, k)])),
  en: Object.fromEntries(PAYMENT_LABEL_KEYS.map((k) => [k, readLabel(en, k)])),
};

function applyPaymentLabels(preset: CurrencyPreset): void {
  for (const lng of ["fr", "en"] as const) {
    for (const key of PAYMENT_LABEL_KEYS) {
      i18next.addResource(lng, "translation", key, preset.mobileMoneyLabel?.[lng] ?? ORIGINAL_LABELS[lng][key]!);
    }
  }
}

export function setCurrency(code: string | null | undefined): void {
  current = findPreset(code);
  try {
    localStorage.setItem(STORAGE_KEY, current.code);
  } catch {
    // stockage indisponible : la devise reste celle de la session
  }
  applyPaymentLabels(current);
}

export function getCurrency(): CurrencyPreset {
  return current;
}

function group(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

// Nombre formaté selon la devise (décimales, séparateurs), sans symbole.
export function formatAmountWith(n: number, preset: CurrencyPreset, thousands: string): string {
  const factor = 10 ** preset.decimals;
  const rounded = Math.round(Math.abs(n) * factor) / factor;
  const [intPart = "0", fracPart] = rounded.toFixed(preset.decimals).split(".");
  const body = group(intPart, thousands) + (fracPart ? preset.decimal + fracPart : "");
  const negative = n < 0 && rounded !== 0;
  return negative ? `-${body}` : body;
}

// À l'écran : séparateur de milliers insécable (jamais de retour à la ligne au
// milieu d'un nombre).
export function formatAmount(n: number): string {
  return formatAmountWith(n, current, current.thousands);
}

// Montant + symbole de la devise, à sa place habituelle (142 500 F, ₦1,500.00, 12,50 €).
export function formatMoney(n: number): string {
  const amount = formatAmountWith(Math.abs(n), current, current.thousands);
  const sign = n < 0 && Math.round(Math.abs(n) * 10 ** current.decimals) !== 0 ? "-" : "";
  return current.symbolPosition === "before"
    ? `${sign}${current.symbol}${amount}`
    : `${sign}${amount}${NBSP}${current.symbol}`;
}

// Documents (tickets ESC/POS, PDF, WhatsApp) : ASCII seulement — les imprimantes
// thermiques et les polices PDF standard ne savent pas afficher NBSP ni ₦/₵.
export function formatAmountPlain(n: number): string {
  const preset = current;
  const thousands = preset.thousands === NBSP ? " " : preset.thousands;
  return formatAmountWith(n, preset, thousands);
}

// Montant suivi du code ISO de la devise (ex. "142 500 XOF") pour les lignes de total.
export function formatMoneyPlain(n: number): string {
  return `${formatAmountPlain(n)} ${current.code}`;
}
