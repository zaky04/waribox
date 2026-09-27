// Pays proposés dans Configuration : sert à ajouter l'indicatif aux numéros de téléphone
// enregistrés en format national (WhatsApp, etc.).
export interface Country {
  iso: string;
  // Nom en français et en anglais (affiché selon la langue de l'interface).
  fr: string;
  en: string;
  // Indicatif téléphonique international, sans « + ».
  dialCode: string;
}

export const COUNTRIES: Country[] = [
  { iso: "CI", fr: "Côte d'Ivoire", en: "Côte d'Ivoire", dialCode: "225" },
  { iso: "SN", fr: "Sénégal", en: "Senegal", dialCode: "221" },
  { iso: "ML", fr: "Mali", en: "Mali", dialCode: "223" },
  { iso: "BF", fr: "Burkina Faso", en: "Burkina Faso", dialCode: "226" },
  { iso: "BJ", fr: "Bénin", en: "Benin", dialCode: "229" },
  { iso: "TG", fr: "Togo", en: "Togo", dialCode: "228" },
  { iso: "NE", fr: "Niger", en: "Niger", dialCode: "227" },
  { iso: "GN", fr: "Guinée", en: "Guinea", dialCode: "224" },
  { iso: "MR", fr: "Mauritanie", en: "Mauritania", dialCode: "222" },
  { iso: "GM", fr: "Gambie", en: "Gambia", dialCode: "220" },
  { iso: "LR", fr: "Liberia", en: "Liberia", dialCode: "231" },
  { iso: "SL", fr: "Sierra Leone", en: "Sierra Leone", dialCode: "232" },
  { iso: "GH", fr: "Ghana", en: "Ghana", dialCode: "233" },
  { iso: "NG", fr: "Nigeria", en: "Nigeria", dialCode: "234" },
  { iso: "CM", fr: "Cameroun", en: "Cameroon", dialCode: "237" },
  { iso: "GA", fr: "Gabon", en: "Gabon", dialCode: "241" },
  { iso: "CG", fr: "Congo-Brazzaville", en: "Congo (Brazzaville)", dialCode: "242" },
  { iso: "CD", fr: "RD Congo", en: "DR Congo", dialCode: "243" },
  { iso: "TD", fr: "Tchad", en: "Chad", dialCode: "235" },
  { iso: "CF", fr: "Centrafrique", en: "Central African Republic", dialCode: "236" },
  { iso: "GQ", fr: "Guinée équatoriale", en: "Equatorial Guinea", dialCode: "240" },
  { iso: "MG", fr: "Madagascar", en: "Madagascar", dialCode: "261" },
  { iso: "MA", fr: "Maroc", en: "Morocco", dialCode: "212" },
  { iso: "DZ", fr: "Algérie", en: "Algeria", dialCode: "213" },
  { iso: "TN", fr: "Tunisie", en: "Tunisia", dialCode: "216" },
  { iso: "FR", fr: "France", en: "France", dialCode: "33" },
  { iso: "BE", fr: "Belgique", en: "Belgium", dialCode: "32" },
  { iso: "CH", fr: "Suisse", en: "Switzerland", dialCode: "41" },
  { iso: "LU", fr: "Luxembourg", en: "Luxembourg", dialCode: "352" },
  { iso: "DE", fr: "Allemagne", en: "Germany", dialCode: "49" },
  { iso: "ES", fr: "Espagne", en: "Spain", dialCode: "34" },
  { iso: "IT", fr: "Italie", en: "Italy", dialCode: "39" },
  { iso: "PT", fr: "Portugal", en: "Portugal", dialCode: "351" },
  { iso: "NL", fr: "Pays-Bas", en: "Netherlands", dialCode: "31" },
  { iso: "GB", fr: "Royaume-Uni", en: "United Kingdom", dialCode: "44" },
  { iso: "US", fr: "États-Unis", en: "United States", dialCode: "1" },
  { iso: "CA", fr: "Canada", en: "Canada", dialCode: "1" },
  { iso: "HT", fr: "Haïti", en: "Haiti", dialCode: "509" },
  { iso: "LB", fr: "Liban", en: "Lebanon", dialCode: "961" },
];

export function getCountry(iso: string | null | undefined): Country | undefined {
  return iso ? COUNTRIES.find((c) => c.iso === iso) : undefined;
}

// Premier pays portant cet indicatif (pour les installations qui n'avaient que l'indicatif).
export function findCountryByDialCode(dialCode: string | null | undefined): Country | undefined {
  const digits = (dialCode ?? "").replace(/\D/g, "");
  return digits ? COUNTRIES.find((c) => c.dialCode === digits) : undefined;
}

// Pays dont le numéro national garde son 0 initial à l'international (Côte d'Ivoire depuis
// 2021, Bénin depuis 2024 : +225 07 XX XX XX XX). Ailleurs le 0 se retire.
const KEEPS_LEADING_ZERO = new Set(["225", "229"]);

// Numéro prêt pour un lien international (chiffres seuls, indicatif compris), ou null si on
// ne peut pas savoir à quel pays il appartient (numéro national et aucun pays choisi).
export function toInternationalDigits(phone: string, dialCode: string | null | undefined): string | null {
  const raw = phone.trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  // Déjà international : « +… » ou « 00… ».
  if (raw.startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  const code = (dialCode ?? "").replace(/\D/g, "");
  if (!code) return null;
  // Déjà précédé de l'indicatif (numéro complet sans « + »).
  if (digits.startsWith(code) && digits.length >= code.length + 8) return digits;
  return code + (KEEPS_LEADING_ZERO.has(code) ? digits : digits.replace(/^0+/, ""));
}
