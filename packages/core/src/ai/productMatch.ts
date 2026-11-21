// Rapprochement des lignes lues sur un bon de livraison (texte libre, souvent abrégé) avec les produits du catalogue.
// Le résultat est toujours une PROPOSITION que l'utilisateur confirme : une ligne mal lue ou mal rapprochée ne doit
// jamais entrer en stock sans qu'il l'ait vue.

export interface DeliveryLine {
  name: string;
  quantity: number;
  unitCost: number | null;
}

export interface CatalogProduct {
  id: number;
  name: string;
}

export interface LineMatch {
  line: DeliveryLine;
  product: CatalogProduct | null;
  /** 0 à 1 : part des mots de la ligne retrouvés dans le produit (et inversement). */
  score: number;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Mots sans valeur pour distinguer deux produits.
const STOP = new Set(["de", "du", "des", "la", "le", "les", "un", "une", "et", "en", "au", "aux", "pour", "sac", "boite", "carton", "paquet", "pce", "pcs", "x"]);

function tokens(s: string): string[] {
  // « 1 L » et « 1L », « 500 g » et « 500g » sont la même quantité.
  return norm(s)
    .replace(/(\d)\s+([a-z])/g, "$1$2")
    .split(" ")
    .filter((t) => t && !STOP.has(t));
}

/** Ressemblance entre deux libellés : moyenne des deux couvertures de mots (1 = mêmes mots). */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  // Un mot compte s'il est identique ou si l'un est le début de l'autre (« choco » / « chocolat »), à partir de 3 lettres.
  const close = (x: string, y: string) => x === y || (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x)));
  let hitsA = 0;
  for (const x of ta) if ([...tb].some((y) => close(x, y))) hitsA++;
  let hitsB = 0;
  for (const y of tb) if ([...ta].some((x) => close(x, y))) hitsB++;
  return (hitsA / ta.size + hitsB / tb.size) / 2;
}

export const MIN_MATCH_SCORE = 0.6;

/** Meilleur produit du catalogue pour chaque ligne, ou null sous le seuil. Un même produit peut recevoir plusieurs lignes. */
export function matchDeliveryLines(lines: DeliveryLine[], products: CatalogProduct[], minScore = MIN_MATCH_SCORE): LineMatch[] {
  return lines.map((line) => {
    let best: CatalogProduct | null = null;
    let bestScore = 0;
    for (const product of products) {
      const score = nameSimilarity(line.name, product.name);
      if (score > bestScore) {
        best = product;
        bestScore = score;
      }
    }
    return { line, product: bestScore >= minScore ? best : null, score: Math.round(bestScore * 100) / 100 };
  });
}

/** Valide ce que l'IA a renvoyé : une liste de lignes plausibles, sans quantité absurde. */
export function sanitizeDeliveryLines(raw: unknown): DeliveryLine[] {
  const rows = (raw as { lines?: unknown })?.lines;
  if (!Array.isArray(rows)) return [];
  const out: DeliveryLine[] = [];
  for (const row of rows.slice(0, 200)) {
    const r = row as { name?: unknown; quantity?: unknown; unitCost?: unknown };
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 120) : "";
    const quantity = Number(r.quantity);
    const cost = r.unitCost == null ? null : Number(r.unitCost);
    if (!name || !Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) continue;
    out.push({ name, quantity: Math.round(quantity * 1000) / 1000, unitCost: cost != null && Number.isFinite(cost) && cost >= 0 ? cost : null });
  }
  return out;
}
