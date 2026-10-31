// Logique pure du pack Pharmacie (aucun accès base) : testable sans harnais SQLite.

// Texte comparable : sans accents, minuscules, espaces normalisés. « Paracétamol »
// et « paracetamol » désignent la même molécule ; « 500 mg » et « 500mg » aussi.
export function normalizeMolecule(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

export interface MoleculeInfo {
  dci?: string | null;
  dosage?: string | null;
  dosageForm?: string | null;
}

// Deux produits sont équivalents s'ils ont la même DCI et le même dosage. La forme
// (comprimé, sirop…) ne départage que si les DEUX produits l'ont renseignée.
// Sans DCI, aucune équivalence n'est jamais proposée (on ne devine rien).
export function areEquivalent(a: MoleculeInfo, b: MoleculeInfo): boolean {
  const dciA = normalizeMolecule(a.dci);
  if (!dciA || dciA !== normalizeMolecule(b.dci)) return false;
  if (normalizeMolecule(a.dosage) !== normalizeMolecule(b.dosage)) return false;
  const formA = normalizeMolecule(a.dosageForm);
  const formB = normalizeMolecule(b.dosageForm);
  if (formA && formB && formA !== formB) return false;
  return true;
}

// Coût d'une unité détaillée = coût de la boîte / unités contenues. Le coût total
// reste identique avant et après avoir ouvert la boîte.
export function breakdownUnitCost(parentUnitCost: number | null | undefined, unitsPerParent: number): number | undefined {
  if (parentUnitCost == null || !(unitsPerParent > 0)) return undefined;
  return parentUnitCost / unitsPerParent;
}

// Une vente qui contient un produit sur ordonnance doit porter une référence.
export function missingPrescription(
  lines: { requiresPrescription: boolean }[],
  prescriptionRef: string | null | undefined,
): boolean {
  return lines.some((l) => l.requiresPrescription) && !prescriptionRef?.trim();
}
