// Affichage des horodatages enregistrés en UTC.
//
// La base stocke `created_at` & co. en UTC (« AAAA-MM-JJ HH:MM:SS », sans fuseau), alors que l'utilisateur lit
// l'heure de son fuseau. Afficher la chaîne brute décalait les heures (Nigeria, Cameroun, Europe...). En fuseau
// UTC (Côte d'Ivoire, Ghana, Sénégal...) le résultat est identique à la chaîne d'origine, minutes près.

const pad = (n: number) => String(n).padStart(2, "0");

function parse(value: string): Date | null {
  const iso = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : iso + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

/** « AAAA-MM-JJ HH:MM » en heure locale ; la valeur d'origine si elle n'est pas lisible ; vide si absente. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = parse(value);
  if (!d) return value;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** « AAAA-MM-JJ » en heure locale. */
export function formatLocalDate(value: string | null | undefined): string {
  return formatDateTime(value).slice(0, 10);
}
