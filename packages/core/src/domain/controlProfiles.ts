// Profils de contrôle : selon la présence du propriétaire, des réglages de départ
// (seuils d'approbation, mode, délai d'alerte) appliqués en un clic — ensuite
// modifiables un par un. Les seuils sont exprimés pour le FCFA puis mis à
// l'échelle de la devise choisie (un seuil de 5 000 F n'a pas de sens en euros).
export type ControlProfileId = "present" | "evening" | "periodic";

export interface ControlProfileValues {
  approvalRefundThreshold: number;
  approvalStockThreshold: number;
  approvalCreditThreshold: number;
  approvalDiscountThreshold: number;
  approvalExpenseThreshold: number;
  approvalPointsThreshold: number;
  approvalTicketThreshold: number;
  approvalPriceThreshold: number;
  approvalPaymentThreshold: number;
  approvalModeStock: "pin" | "later";
  approvalModeExpense: "pin" | "later";
  approvalModePoints: "pin" | "later";
  approvalPendingAlertHours: number;
}

export const CONTROL_PROFILE_IDS: ControlProfileId[] = ["present", "evening", "periodic"];

// Valeur d'une unité de la devise en FCFA (approximatif : sert seulement à donner
// des seuils de départ raisonnables).
const XOF_PER_UNIT: Record<string, number> = { XOF: 1, XAF: 1, NGN: 0.4, GHS: 55, EUR: 656, USD: 600, GBP: 780 };

// Arrondi « lisible » (2 chiffres significatifs, au moins 1).
export function niceRound(value: number): number {
  if (value <= 0) return 0;
  const digits = Math.floor(Math.log10(value));
  const step = Math.pow(10, Math.max(0, digits - 1));
  return Math.max(1, Math.round(value / step) * step);
}

function scaled(baseXof: number, currencyCode: string): number {
  if (baseXof === 0) return 0;
  return niceRound(baseXof / (XOF_PER_UNIT[currencyCode] ?? 1));
}

export function getControlProfile(id: ControlProfileId, currencyCode = "XOF"): ControlProfileValues {
  const m = (xof: number) => scaled(xof, currencyCode);
  switch (id) {
    case "present":
      // Le propriétaire est là : tout passe par son code, sur le moment.
      return {
        approvalRefundThreshold: 0,
        approvalStockThreshold: 0,
        approvalCreditThreshold: 0,
        approvalDiscountThreshold: 0,
        approvalExpenseThreshold: 0,
        approvalPointsThreshold: 0,
        approvalTicketThreshold: 0,
        approvalPriceThreshold: 0,
        approvalPaymentThreshold: 0,
        approvalModeStock: "pin",
        approvalModeExpense: "pin",
        approvalModePoints: "pin",
        approvalPendingAlertHours: 4,
      };
    case "evening":
      // Passage chaque soir : petits montants libres, le reste attend la validation du soir.
      return {
        approvalRefundThreshold: m(5000),
        approvalStockThreshold: 0,
        approvalCreditThreshold: m(25000),
        approvalDiscountThreshold: m(1000),
        approvalExpenseThreshold: m(10000),
        approvalPointsThreshold: 50,
        approvalTicketThreshold: m(5000),
        approvalPriceThreshold: m(500),
        approvalPaymentThreshold: m(25000),
        approvalModeStock: "later",
        approvalModeExpense: "later",
        approvalModePoints: "later",
        approvalPendingAlertHours: 24,
      };
    case "periodic":
      // Passage hebdomadaire ou mensuel : le gérant (avec un plafond d'approbation)
      // décide au quotidien, le propriétaire contrôle après coup.
      return {
        approvalRefundThreshold: m(25000),
        approvalStockThreshold: m(10000),
        approvalCreditThreshold: m(100000),
        approvalDiscountThreshold: m(5000),
        approvalExpenseThreshold: m(50000),
        approvalPointsThreshold: 500,
        approvalTicketThreshold: m(25000),
        approvalPriceThreshold: m(2000),
        approvalPaymentThreshold: m(100000),
        approvalModeStock: "later",
        approvalModeExpense: "later",
        approvalModePoints: "later",
        approvalPendingAlertHours: 168,
      };
  }
}
