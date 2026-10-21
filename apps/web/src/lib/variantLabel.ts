// Nom lisible d'une variante. Les variantes ordinaires gardent leurs attributs
// JSON affichés tels quels (comportement historique) ; une présentation détaillée
// d'une boîte (pack Pharmacie, `parentVariantId` renseigné) s'affiche « Produit
// (Plaquette) ».
interface VariantLike {
  attributes: string | null;
  parentVariantId?: number | null;
}

export function variantPresentation(variant: VariantLike): string {
  try {
    return (JSON.parse(variant.attributes ?? "{}") as { presentation?: string }).presentation ?? "";
  } catch {
    return "";
  }
}

export function variantFullName(variant: VariantLike, productName: string): string {
  if (variant.parentVariantId != null) {
    const presentation = variantPresentation(variant);
    return presentation ? `${productName} (${presentation})` : productName;
  }
  const attrs = variant.attributes && variant.attributes !== "{}" ? ` (${variant.attributes})` : "";
  return `${productName}${attrs}`;
}
