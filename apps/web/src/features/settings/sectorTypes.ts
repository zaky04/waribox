// Secteurs d'activité proposés dans Paramètres — pilote le champ
// `business_settings.sectorType`, qui n'adapte plus que l'icône/libellé de
// l'onglet "Produits" (voir Nav.tsx) depuis que la couleur/forme de l'app
// s'est détachée du secteur au profit d'une section "Apparence" à part
// entière (voir appearancePresets.ts, lib/appearance.ts). Liste
// volontairement courte et curatée — la colonne reste un `text` libre en
// base (pas d'enum SQL), donc rien n'empêche techniquement une autre
// valeur, mais seules ces 4 ont une adaptation d'icône associée pour
// l'instant. Aucune option "Autre" : une valeur vide/`null` équivaut déjà à
// "pas de secteur choisi" et garde l'icône/libellé par défaut — pas besoin
// de la lister explicitement.
export type SectorType = "boutique" | "pharmacie" | "restaurant" | "pressing";

export const SECTOR_OPTIONS: { value: SectorType; labelKey: string }[] = [
  { value: "boutique", labelKey: "settings.business.sectorBoutique" },
  { value: "pharmacie", labelKey: "settings.business.sectorPharmacie" },
  { value: "restaurant", labelKey: "settings.business.sectorRestaurant" },
  { value: "pressing", labelKey: "settings.business.sectorPressing" },
];

export function isSectorType(value: string | null | undefined): value is SectorType {
  return value === "boutique" || value === "pharmacie" || value === "restaurant" || value === "pressing";
}
