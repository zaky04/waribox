import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq, like, sql } from "drizzle-orm";

// Numérotation des documents (VTE-2026-000123, ACH-…, DEV-…, TCK-…).
//
// Avant : « nombre de lignes + 1 ». Deux défauts réels :
//  - une ligne supprimée faisait réutiliser un numéro (violation d'unicité) ;
//  - la suite ne repartait jamais de 1 au changement d'année, alors que le
//    contrôle des numéros manquants (findNumberGaps) raisonne année par année.
// Maintenant : plus grand numéro de l'année + 1. Les numéros suffixés produits
// par `uniqueNumber` (ex. VTE-2026-000004-A1B2) comptent aussi, leur début étant
// le numéro d'origine.

type NumberedTable = typeof schema.sales | typeof schema.purchases | typeof schema.quotes | typeof schema.serviceOrders;

export function formatDocumentNumber(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(6, "0")}`;
}

export async function nextDocumentNumber(db: Database, table: NumberedTable, prefix: string, year = new Date().getFullYear()): Promise<string> {
  const base = `${prefix}-${year}-`;
  const row = await db
    .select({ max: sql<number | null>`MAX(CAST(SUBSTR(${table.number}, ${base.length + 1}) AS INTEGER))` })
    .from(table)
    .where(like(table.number, `${base}%`))
    .get();
  return formatDocumentNumber(prefix, year, (Number(row?.max) || 0) + 1);
}

// Numéro d'une vente reçue d'un autre appareil : conservé tel quel s'il est libre ;
// sinon (deux appareils hors ligne ont chacun pris le « prochain » numéro) on
// ajoute un suffixe tiré de l'identité de la vente, pour qu'elle soit acceptée au
// lieu d'être refusée à jamais. Le début du numéro reste celui imprimé sur le
// ticket du client.
export async function uniqueSaleNumber(db: Database, number: string, syncId: string): Promise<string> {
  const taken = async (candidate: string) =>
    !!(await db.select({ id: schema.sales.id }).from(schema.sales).where(eq(schema.sales.number, candidate)).get());
  if (!(await taken(number))) return number;
  const tag = syncId.replace(/-/g, "").toUpperCase();
  for (let length = 4; length <= tag.length; length += 2) {
    const candidate = `${number}-${tag.slice(0, length)}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new Error(`numéro de vente déjà utilisé : ${number}`);
}
