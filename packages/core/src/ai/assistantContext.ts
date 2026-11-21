import type { Database } from "@gestion-boutique/database";
import { getCurrency } from "@gestion-boutique/i18n";
import { getLowStockProducts } from "../services/StockService";
import { getSalesSummary, getTopProducts } from "../services/ReportsService";
import { listCustomerCredits } from "../services/CreditsService";
import { roundMoney } from "../domain/money";
import { localDayString } from "../services/AlertService";

// Contexte envoyé à l'assistant IA (facultatif) : UNIQUEMENT des totaux et des noms de produits. Jamais de nom de
// client, de numéro de téléphone, de nom d'employé ni d'identifiant : ce que le patron demande se répond avec des
// chiffres agrégés, et ce qui part vers un service extérieur doit rester minimal. L'assistant ne reçoit aucun accès à
// la base : il lit ce résumé, rien d'autre, et ne peut rien modifier.

export interface AssistantContext {
  date: string;
  currency: string;
  salesToday: { count: number; total: number };
  salesYesterday: { count: number; total: number };
  salesLast7Days: { count: number; total: number };
  salesLast30Days: { count: number; total: number };
  /** Ventes par jour sur 30 jours (jours sans vente omis). */
  salesByDay: Array<{ date: string; total: number }>;
  topProducts30Days: Array<{ name: string; quantity: number; revenue: number }>;
  lowStock: Array<{ name: string; stock: number; threshold: number }>;
  openCredits: { count: number; totalRemaining: number };
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

export async function buildAssistantContext(db: Database, now: Date = new Date(), storeId?: number): Promise<AssistantContext> {
  const today = localDayString(now);
  const yesterday = addDays(today, -1);
  const [t0, t1, t7, t30, top, low, credits] = await Promise.all([
    getSalesSummary(db, { from: today, to: today }, storeId),
    getSalesSummary(db, { from: yesterday, to: yesterday }, storeId),
    getSalesSummary(db, { from: addDays(today, -6), to: today }, storeId),
    getSalesSummary(db, { from: addDays(today, -29), to: today }, storeId),
    getTopProducts(db, { from: addDays(today, -29), to: today }, 10, storeId),
    getLowStockProducts(db, storeId),
    listCustomerCredits(db, storeId),
  ]);
  const open = credits.filter((c) => c.status !== "settled" && c.remainingBalance > 0);
  const pack = (s: { saleCount: number; totalRevenue: number }) => ({ count: s.saleCount, total: roundMoney(s.totalRevenue) });
  return {
    date: today,
    currency: getCurrency().code,
    salesToday: pack(t0),
    salesYesterday: pack(t1),
    salesLast7Days: pack(t7),
    salesLast30Days: pack(t30),
    salesByDay: t30.byDay.filter((d) => d.total !== 0).map((d) => ({ date: d.date, total: roundMoney(d.total) })),
    topProducts30Days: top.map((p) => ({ name: p.name, quantity: p.quantity, revenue: roundMoney(p.revenue) })),
    lowStock: low.slice(0, 15).map((l) => ({ name: l.product.name, stock: l.totalStock, threshold: l.product.lowStockThreshold })),
    openCredits: { count: open.length, totalRemaining: roundMoney(open.reduce((sum, c) => sum + c.remainingBalance, 0)) },
  };
}

/** Consigne système de l'assistant : répondre d'après le résumé fourni, sans rien inventer. */
export const ASSISTANT_SYSTEM_PROMPT = [
  "Tu es l'assistant d'un commerçant qui utilise le logiciel de caisse WariBox.",
  "Tu réponds à ses questions d'après le RÉSUMÉ CHIFFRÉ fourni ci-dessous, et seulement lui.",
  "Si le résumé ne permet pas de répondre (par exemple une question sur un client précis, un employé, ou une période plus ancienne que 30 jours), dis-le simplement et indique où trouver l'information dans WariBox (Rapports, Contrôles, Créances, Stock).",
  "N'invente aucun chiffre. Cite les montants avec la devise du résumé. Réponds en quelques phrases courtes, dans la langue de la question, sans jargon.",
  "Tu ne peux rien modifier dans le logiciel : si on te le demande, explique comment faire.",
].join("\n");

/** Message utilisateur : le résumé en JSON, puis la question. */
export function buildAssistantUserMessage(context: AssistantContext, question: string): string {
  return `RÉSUMÉ CHIFFRÉ (JSON) :\n${JSON.stringify(context)}\n\nQUESTION DU COMMERÇANT :\n${question.trim().slice(0, 1000)}`;
}
