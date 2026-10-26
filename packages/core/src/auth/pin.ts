import { t } from "@gestion-boutique/i18n";

// Un code PIN protège les approbations (remises, remboursements, dépenses,
// pertes de stock...) : 4 chiffres ne représentent que 10 000 combinaisons,
// trouvables en quelques heures si le hash est récupéré (sauvegarde, appareil
// volé). 6 à 8 chiffres, imposés ICI (côté service) et pas seulement par
// l'écran. Les anciens PIN de 4 chiffres restent valides tant qu'on ne les change pas.
export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 8;

export function isValidNewPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

export function assertValidPin(pin: string): void {
  if (!isValidNewPin(pin)) throw new Error(t("coreErrors.auth.pinInvalid"));
}

// Le hash du PIN d'un responsable n'est jamais copié sur un appareil relié :
// l'instantané du catalogue y met ce marqueur à la place, et la vérification du
// PIN se fait chez le Maître (voir pinProof.ts / remotePin.ts). Sans lui, la
// base d'un téléphone perdu suffirait à retrouver le PIN du propriétaire hors ligne.
export const REMOTE_PIN_HASH = "remote:v1";

export function isRemotePinHash(hash: string | null | undefined): boolean {
  return typeof hash === "string" && hash.startsWith("remote:");
}
