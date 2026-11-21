import { t } from "@gestion-boutique/i18n";

// Photo d'un produit, stockée dans la base sous forme d'URL de données (data:image/…;base64,…). Elle est
// réduite à une vignette par l'interface avant l'enregistrement : la limite ci-dessous est un garde-fou
// côté service (une photo brute de téléphone ferait plusieurs Mo et gonflerait la base, les sauvegardes et
// l'instantané envoyé aux appareils reliés).
export const MAX_PRODUCT_IMAGE_CHARS = 60_000;

const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

/** Vide ou espaces → null (pas de photo). Lève une erreur si la valeur n'est pas une vignette acceptable. */
export function cleanProductImage(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_PRODUCT_IMAGE_CHARS || !IMAGE_DATA_URL.test(trimmed)) {
    throw new Error(t("coreErrors.products.imageInvalid"));
  }
  return trimmed;
}
