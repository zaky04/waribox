// Réappro qui tient compte des fêtes : avant Tabaski, l'Aïd, Noël ou la rentrée, on vend plus que d'habitude. Le rythme
// de vente des 30 derniers jours ignore la fête qui arrive, donc une commande calée dessus manque de stock au pire
// moment. Les coefficients ci-dessous sont des ORDRES DE GRANDEUR prudents, pas des mesures : ils sont toujours
// affichés à l'utilisateur, qui peut les désactiver, et la quantité reste modifiable avant de commander.

export type SeasonalEventKey = "ramadan" | "eidFitr" | "tabaski" | "christmas" | "newYear" | "backToSchool";

export interface SeasonalEvent {
  key: SeasonalEventKey;
  /** Jour de la fête (AAAA-MM-JJ). */
  date: string;
  /** Jours AVANT la fête pendant lesquels la demande monte. */
  leadDays: number;
  /** Coefficient de la demande pendant cette période. */
  factor: number;
}

// Fêtes musulmanes : dates astronomiques prévues, à ±1 jour selon l'observation de la lune. Les années au-delà de 2030
// ne sont pas prévues : sans événement, le coefficient vaut simplement 1.
const LUNAR: Record<number, { ramadan: string; eidFitr: string; tabaski: string }> = {
  2026: { ramadan: "2026-02-18", eidFitr: "2026-03-20", tabaski: "2026-05-27" },
  2027: { ramadan: "2027-02-08", eidFitr: "2027-03-09", tabaski: "2027-05-16" },
  2028: { ramadan: "2028-01-28", eidFitr: "2028-02-26", tabaski: "2028-05-05" },
  2029: { ramadan: "2029-01-16", eidFitr: "2029-02-14", tabaski: "2029-04-24" },
  2030: { ramadan: "2030-01-05", eidFitr: "2030-02-04", tabaski: "2030-04-13" },
};

const FACTORS = { ramadan: { leadDays: 10, factor: 1.35 }, eidFitr: { leadDays: 10, factor: 1.5 }, tabaski: { leadDays: 21, factor: 1.5 } } as const;

/** Les fêtes connues d'une année civile. */
export function seasonalEventsOfYear(year: number): SeasonalEvent[] {
  const events: SeasonalEvent[] = [
    { key: "newYear", date: `${year}-01-01`, leadDays: 10, factor: 1.3 },
    { key: "backToSchool", date: `${year}-09-15`, leadDays: 21, factor: 1.25 },
    { key: "christmas", date: `${year}-12-25`, leadDays: 14, factor: 1.4 },
  ];
  const lunar = LUNAR[year];
  if (lunar) {
    events.push({ key: "ramadan", date: lunar.ramadan, ...FACTORS.ramadan });
    events.push({ key: "eidFitr", date: lunar.eidFitr, ...FACTORS.eidFitr });
    events.push({ key: "tabaski", date: lunar.tabaski, ...FACTORS.tabaski });
  }
  return events;
}

function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T12:00:00Z`) / 86400000);
}

export interface SeasonalOutlook {
  /** Coefficient moyen sur l'horizon (1 = aucune fête). */
  factor: number;
  /** Fêtes qui pèsent sur l'horizon, la plus proche d'abord. */
  events: Array<{ key: SeasonalEventKey; date: string; daysUntil: number; factor: number }>;
}

/**
 * Coefficient moyen de la demande sur les `horizonDays` jours qui suivent `today` (AAAA-MM-JJ) : chaque jour prend le
 * coefficient de la fête dont la période de hausse le contient (le plus fort s'il y en a plusieurs), la moyenne en
 * est faite sur l'horizon. Une commande passée à 3 semaines de Tabaski n'est donc pas gonflée comme celle de la veille.
 */
export function seasonalOutlook(today: string, horizonDays: number): SeasonalOutlook {
  const start = dayNumber(today);
  const year = Number(today.slice(0, 4));
  const events = [year - 1, year, year + 1].flatMap(seasonalEventsOfYear);
  let sum = 0;
  const touched = new Map<string, SeasonalOutlook["events"][number]>();
  for (let i = 0; i < horizonDays; i++) {
    const day = start + i;
    let best = 1;
    for (const event of events) {
      const eventDay = dayNumber(event.date);
      if (day >= eventDay - event.leadDays && day <= eventDay) {
        best = Math.max(best, event.factor);
        const id = `${event.key}-${event.date}`;
        if (!touched.has(id)) touched.set(id, { key: event.key, date: event.date, daysUntil: eventDay - start, factor: event.factor });
      }
    }
    sum += best;
  }
  return {
    factor: horizonDays > 0 ? Math.round((sum / horizonDays) * 100) / 100 : 1,
    events: [...touched.values()].sort((a, b) => a.daysUntil - b.daysUntil),
  };
}

/**
 * Quantité à commander pour couvrir `horizonDays` jours : le rythme de vente réel (par jour) × l'horizon × le
 * coefficient des fêtes, moins le stock. Sans historique de vente, on ramène le stock au double du seuil d'alerte
 * (le coefficient n'y change rien : il n'y a pas de rythme à corriger). Toujours au moins 1.
 */
export function suggestRestockQuantity(input: { dailyVelocity: number; stock: number; horizonDays: number; lowStockThreshold: number; seasonFactor?: number }): number {
  const factor = input.seasonFactor && input.seasonFactor > 0 ? input.seasonFactor : 1;
  if (input.dailyVelocity > 0) {
    return Math.max(1, Math.ceil(input.dailyVelocity * input.horizonDays * factor - input.stock));
  }
  return Math.max(1, Math.ceil(input.lowStockThreshold * 2 - input.stock));
}
