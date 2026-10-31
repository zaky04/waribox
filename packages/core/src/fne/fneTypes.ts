// Contrat HTTP de la FNE (Facture Normalisée Électronique, Côte d'Ivoire,
// DGI) — voir CLAUDE.md. Déduit par lecture directe du code source du SDK
// PHP tiers non-officiel PRODESTIC/fne-sdk-php (HttpClient.php,
// InvoiceService.php, Utils/Constants.php, Models/Invoice.php,
// Models/InvoiceItem.php) le 19 septembre 2026 — PAS de la documentation
// officielle DGI, jamais obtenue. À vérifier/ajuster dès qu'un vrai accès
// DGI existe (voir le bouton "Tester la connexion" de Paramètres).

// URL fixe du bac à sable — en dur dans le SDK tiers, en HTTP simple (pas
// HTTPS). L'URL de production est fournie par la DGI à la validation du
// compte, saisie par l'utilisateur (business_settings.fneApiBaseUrl).
export const FNE_TEST_BASE_URL = "http://54.247.95.108/ws";
export const FNE_SIGN_INVOICE_ENDPOINT = "/external/invoices/sign";

export type FneInvoiceType = "sale" | "purchase";
export type FnePaymentMethod = "cash" | "card" | "check" | "mobile-money" | "transfer" | "deferred";
export type FneTemplate = "B2C" | "B2B" | "B2F" | "B2G";
export type FneTaxCode = "TVA" | "TVAB" | "TVAC" | "TVAD";

export interface FneInvoiceItem {
  description: string;
  quantity: number;
  amount: number; // prix unitaire
  taxes: FneTaxCode[];
  discount?: number; // pourcentage 0-100, pas un montant
  reference?: string;
  measurementUnit?: string;
}

export interface FneInvoicePayload {
  invoiceType: FneInvoiceType;
  paymentMethod: FnePaymentMethod;
  template: FneTemplate;
  pointOfSale: string;
  establishment: string;
  clientCompanyName: string;
  clientPhone: string;
  clientEmail: string;
  isRne: boolean;
  items: FneInvoiceItem[];
  clientNcc?: string; // requis si template === "B2B"
  discount?: number; // pourcentage global 0-100, pas un montant
  foreignCurrency: string; // "" si non utilisé
  foreignCurrencyRate: number; // 0 si non utilisé
}

export interface FneCertificationResult {
  ncc: string;
  reference: string; // numéro de facture normé
  token: string; // QR code (URL/jeton)
  warning: boolean;
  balanceSticker: number;
}

export interface FneApiErrorPayload {
  message: string;
}
