// Jours « locaux » et horodatages enregistrés en UTC.
//
// Les dates de création (`created_at` = CURRENT_TIMESTAMP de SQLite) sont stockées en UTC,
// alors que l'utilisateur raisonne en jours de SON fuseau (« les ventes d'aujourd'hui »,
// choisi dans un sélecteur de date). Comparer directement le texte « 2026-10-31 00:00:00 »
// à ces horodatages décale les journées dès que le fuseau n'est pas UTC (Nigeria, Cameroun,
// Europe : une vente à 23h30 locale tombait dans le jour suivant). Ces fonctions convertissent
// les bornes d'un jour local en bornes UTC, et un horodatage UTC en jour local pour les
// regroupements. En fuseau UTC (Côte d'Ivoire, Ghana, Sénégal...) elles ne changent rien.

const pad = (n: number) => String(n).padStart(2, "0");

function toSqlUtc(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function parseDay(day: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Début (00:00:00 local) du jour « AAAA-MM-JJ », exprimé en UTC au format SQL. */
export function localDayStartUtc(day: string): string {
  const p = parseDay(day);
  if (!p) return `${day.slice(0, 10)} 00:00:00`;
  return toSqlUtc(new Date(p[0], p[1] - 1, p[2], 0, 0, 0));
}

/** Fin (23:59:59 local) du jour « AAAA-MM-JJ », exprimée en UTC au format SQL. */
export function localDayEndUtc(day: string): string {
  const p = parseDay(day);
  if (!p) return `${day.slice(0, 10)} 23:59:59`;
  return toSqlUtc(new Date(p[0], p[1] - 1, p[2], 23, 59, 59));
}

/** Jour local (AAAA-MM-JJ) d'un horodatage enregistré en UTC. */
export function utcToLocalDay(createdAt: string): string {
  const d = new Date(createdAt.includes("T") ? createdAt : createdAt.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return createdAt.slice(0, 10);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
