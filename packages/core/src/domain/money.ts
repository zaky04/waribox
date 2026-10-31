// Arrondi au centime : les montants saisis/affichés ont au plus 2 décimales
// (devises à centimes : EUR, NGN, GHS...), mais les additions à virgule
// flottante laissent des résidus (0,1 + 0,2 = 0,30000000000000004) qui
// faisaient passer un paiement exact pour un paiement partiel. Sans effet sur
// les montants entiers (XOF/XAF).
export function roundMoney(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
