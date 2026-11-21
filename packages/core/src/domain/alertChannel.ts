// Canal d'envoi automatique des alertes : une adresse (URL) que l'application appelle avec le texte du message.
// Sans serveur propre à WariBox, c'est le seul moyen d'envoyer sans qu'une personne appuie sur « envoyer » :
// l'adresse est celle d'un service que le patron choisit lui-même (robot Telegram, CallMeBot pour WhatsApp,
// ntfy...). Ex. : https://api.telegram.org/bot<clé>/sendMessage?chat_id=<id>&text={text}

export const ALERT_SEVERITIES = ["info", "warning", "danger"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

const RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, danger: 2 };

export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return value === "info" || value === "warning" || value === "danger";
}

/** Vrai si `severity` atteint le niveau minimum choisi. */
export function meetsSeverity(severity: AlertSeverity, minimum: AlertSeverity): boolean {
  return RANK[severity] >= RANK[minimum];
}

export function severityRank(severity: AlertSeverity): number {
  return RANK[severity];
}

export type AlertChannelCheck = "ok" | "empty" | "notHttps" | "noTextPlaceholder" | "invalid";

/** Vérifie l'adresse saisie : HTTPS obligatoire (le texte des alertes ne doit pas circuler en clair) et `{text}`. */
export function checkAlertChannelUrl(template: string | null | undefined): AlertChannelCheck {
  const value = template?.trim();
  if (!value) return "empty";
  if (!value.includes("{text}")) return "noTextPlaceholder";
  let url: URL;
  try {
    url = new URL(value.replace("{text}", "x").replace("{phone}", "x"));
  } catch {
    return "invalid";
  }
  return url.protocol === "https:" ? "ok" : "notHttps";
}

// Une adresse trop longue est refusée par de nombreux serveurs : le texte est tronqué.
export const MAX_ALERT_TEXT = 1200;

/** Adresse à appeler pour ce message : `{text}` (et `{phone}`) remplacés, encodés pour une adresse. */
export function buildAlertRequestUrl(template: string, text: string, phone?: string | null): string {
  const clipped = text.length > MAX_ALERT_TEXT ? `${text.slice(0, MAX_ALERT_TEXT - 1)}…` : text;
  return template
    .replaceAll("{text}", encodeURIComponent(clipped))
    .replaceAll("{phone}", encodeURIComponent((phone ?? "").replace(/[^\d+]/g, "")));
}

/** « HH:MM » sur 24 h. */
export function isValidSummaryTime(value: string | null | undefined): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Minutes écoulées depuis minuit pour « HH:MM ». */
export function summaryTimeMinutes(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Faut-il renvoyer une alerte déjà signalée ? Oui si elle s'est aggravée (valeur plus forte, gravité plus
 * haute) ou si le dernier envoi date de plus de `repeatDays` jours : un problème qui persiste est rappelé,
 * sans répéter le même message toutes les demi-heures.
 */
export function shouldRenotify(
  previous: { value: number; severity: AlertSeverity; at: string } | null,
  current: { value: number; severity: AlertSeverity },
  now: Date,
  repeatDays = 7,
): boolean {
  if (!previous) return true;
  if (severityRank(current.severity) > severityRank(previous.severity)) return true;
  if (Math.abs(current.value) > Math.abs(previous.value)) return true;
  const sent = Date.parse(previous.at);
  return Number.isNaN(sent) || now.getTime() - sent > repeatDays * 86400000;
}
