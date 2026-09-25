// Montant entier avec séparateur de milliers insécable (142 500) — jamais de
// retour à la ligne au milieu d'un nombre, et identique quelle que soit la
// locale de l'appareil (contrairement à toLocaleString).
export function formatAmount(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
