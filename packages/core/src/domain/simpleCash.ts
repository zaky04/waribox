// Aides du mode caisse simplifié (pensé pour les employés qui lisent peu) : rendu de monnaie en billets et
// pièces, présenté sous forme d'images plutôt que de chiffres seuls.

export interface ChangePart {
  /** Valeur d'un billet ou d'une pièce. */
  value: number;
  count: number;
}

/**
 * Décompose un rendu de monnaie en billets/pièces, du plus grand au plus petit (méthode gloutonne).
 * `denominations` : les coupures de la devise ; l'ordre n'importe pas. Un reste qu'aucune coupure ne
 * permet de former (monnaie plus fine que la plus petite pièce) est renvoyé dans `rest` — l'écran l'affiche
 * en chiffres, jamais en images.
 */
export function breakdownChange(amount: number, denominations: number[]): { parts: ChangePart[]; rest: number } {
  const sorted = [...new Set(denominations.filter((d) => d > 0))].sort((a, b) => b - a);
  // Travail en centièmes pour éviter les dérives des flottants (0,1 + 0,2).
  let remaining = Math.round(Math.max(0, amount) * 100);
  const parts: ChangePart[] = [];
  for (const value of sorted) {
    const cents = Math.round(value * 100);
    const count = Math.floor(remaining / cents);
    if (count > 0) {
      parts.push({ value, count });
      remaining -= count * cents;
    }
  }
  return { parts, rest: remaining / 100 };
}

/**
 * Montant tel qu'on le dit à voix haute : « 2500 francs CFA ». Sans séparateur de milliers (les synthèses
 * vocales lisent mal une espace insécable) ; virgule décimale en français, point en anglais.
 */
export function spokenAmount(
  amount: number,
  lang: "fr" | "en",
  currency: { decimals: number; spokenName: { fr: string; en: string } },
): string {
  const factor = 10 ** currency.decimals;
  const rounded = Math.round(amount * factor) / factor;
  const digits = String(rounded);
  return `${lang === "fr" ? digits.replace(".", ",") : digits} ${currency.spokenName[lang]}`;
}
