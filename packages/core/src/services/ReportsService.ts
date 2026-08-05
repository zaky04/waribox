import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { listAllVariants, listProducts } from "./ProductsService";
import { listSales } from "./SalesService";

export interface DateRange {
  from: string;
  to: string;
}

function normalizeRange(range: DateRange): DateRange {
  const from = range.from.length === 10 ? `${range.from} 00:00:00` : range.from;
  const to = range.to.length === 10 ? `${range.to} 23:59:59` : range.to;
  return { from, to };
}

function inRange(createdAt: string, range: DateRange): boolean {
  return createdAt >= range.from && createdAt <= range.to;
}

function dayKey(createdAt: string): string {
  return createdAt.slice(0, 10);
}

function monthKey(createdAt: string): string {
  return createdAt.slice(0, 7);
}

export interface SalesSummary {
  totalRevenue: number;
  saleCount: number;
  averageBasket: number;
  byDay: { date: string; total: number }[];
}

// `userId` restreint aux ventes de ce caissier précis (voir DashboardPage —
// carte "Mes ventes") — indépendant de `storeId`, les deux se combinent.
export async function getSalesSummary(
  db: Database,
  range: DateRange,
  storeId?: number,
  userId?: number,
): Promise<SalesSummary> {
  const normalized = normalizeRange(range);
  const sales = (await listSales(db)).filter(
    (s) =>
      inRange(s.createdAt, normalized) &&
      (!storeId || s.storeId === storeId) &&
      (!userId || s.userId === userId),
  );

  const totalRevenue = sales.reduce((sum, s) => sum + s.total, 0);
  const saleCount = sales.length;
  const averageBasket = saleCount > 0 ? totalRevenue / saleCount : 0;

  const byDayMap = new Map<string, number>();
  for (const sale of sales) {
    const key = dayKey(sale.createdAt);
    byDayMap.set(key, (byDayMap.get(key) ?? 0) + sale.total);
  }
  const byDay = Array.from(byDayMap.entries())
    .map(([date, total]) => ({ date, total }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { totalRevenue, saleCount, averageBasket, byDay };
}

export interface TopProduct {
  productId: number;
  name: string;
  quantity: number;
  revenue: number;
}

export async function getTopProducts(
  db: Database,
  range: DateRange,
  limit = 10,
  storeId?: number,
): Promise<TopProduct[]> {
  const normalized = normalizeRange(range);
  const [sales, allSaleItems, variants, products] = await Promise.all([
    listSales(db),
    db.select().from(schema.saleItems),
    listAllVariants(db),
    listProducts(db),
  ]);

  const saleIdsInRange = new Set(
    sales
      .filter((s) => inRange(s.createdAt, normalized) && (!storeId || s.storeId === storeId))
      .map((s) => s.id),
  );
  const items = allSaleItems.filter((item) => saleIdsInRange.has(item.saleId));

  const byProduct = new Map<number, { name: string; quantity: number; revenue: number }>();
  for (const item of items) {
    const variant = variants.find((v) => v.id === item.variantId);
    const product = variant ? products.find((p) => p.id === variant.productId) : undefined;
    if (!product) continue;
    const existing = byProduct.get(product.id) ?? { name: product.name, quantity: 0, revenue: 0 };
    existing.quantity += item.quantity;
    existing.revenue += item.total;
    byProduct.set(product.id, existing);
  }

  return Array.from(byProduct.entries())
    .map(([productId, v]) => ({ productId, ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

export interface MarginsSummary {
  revenue: number;
  cost: number;
  margin: number;
  marginRate: number;
  byDay: { date: string; margin: number }[];
}

// La marge s'appuie sur products.purchasePrice actuel (pas de coût historique
// par lot d'achat) — approximation volontaire, voir le plan de Phase 7.
export async function getMarginsSummary(
  db: Database,
  range: DateRange,
  storeId?: number,
): Promise<MarginsSummary> {
  const normalized = normalizeRange(range);
  const [sales, allSaleItems, variants, products] = await Promise.all([
    listSales(db),
    db.select().from(schema.saleItems),
    listAllVariants(db),
    listProducts(db),
  ]);

  const salesInRange = new Map(
    sales
      .filter((s) => inRange(s.createdAt, normalized) && (!storeId || s.storeId === storeId))
      .map((s) => [s.id, s] as const),
  );
  const items = allSaleItems.filter((item) => salesInRange.has(item.saleId));

  let revenue = 0;
  let cost = 0;
  const byDayMap = new Map<string, number>();

  for (const item of items) {
    const sale = salesInRange.get(item.saleId);
    if (!sale) continue;
    const variant = variants.find((v) => v.id === item.variantId);
    const product = variant ? products.find((p) => p.id === variant.productId) : undefined;

    const itemRevenue = item.quantity * item.unitPrice - item.discount;
    const itemCost = product ? item.quantity * product.purchasePrice : 0;
    const itemMargin = itemRevenue - itemCost;

    revenue += itemRevenue;
    cost += itemCost;

    const key = dayKey(sale.createdAt);
    byDayMap.set(key, (byDayMap.get(key) ?? 0) + itemMargin);
  }

  const margin = revenue - cost;
  const marginRate = revenue > 0 ? (margin / revenue) * 100 : 0;
  const byDay = Array.from(byDayMap.entries())
    .map(([date, margin]) => ({ date, margin }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { revenue, cost, margin, marginRate, byDay };
}

export interface ProductMarginBreakdown {
  productId: number;
  name: string;
  quantity: number;
  revenue: number;
  cost: number;
  margin: number;
  marginRate: number; // marge / revenu de CE produit, en %
  marginShare: number; // part de CE produit dans la marge totale, en %
  cumulativeShare: number; // part cumulée jusqu'à ce produit inclus (triés par marge décroissante), en %
  abcClass: "A" | "B" | "C";
}

// Analyse ABC (Pareto) appliquée à la marge plutôt qu'au chiffre d'affaires —
// identifie les produits qui contribuent le plus au PROFIT réel, pas
// seulement au volume de vente (un produit très vendu mais peu marginé peut
// être classé C ici alors qu'il serait en tête d'un classement par revenu).
// Classe A = jusqu'à 80% de la marge cumulée, B = jusqu'à 95%, C = le reste.
// Si la marge totale est nulle ou négative, la notion de "part de la marge"
// perd son sens : tous les produits sont alors classés C par défaut.
export async function getProductMarginsBreakdown(
  db: Database,
  range: DateRange,
  storeId?: number,
): Promise<ProductMarginBreakdown[]> {
  const normalized = normalizeRange(range);
  const [sales, allSaleItems, variants, products] = await Promise.all([
    listSales(db),
    db.select().from(schema.saleItems),
    listAllVariants(db),
    listProducts(db),
  ]);

  const salesInRange = new Map(
    sales
      .filter((s) => inRange(s.createdAt, normalized) && (!storeId || s.storeId === storeId))
      .map((s) => [s.id, s] as const),
  );
  const items = allSaleItems.filter((item) => salesInRange.has(item.saleId));

  const byProduct = new Map<
    number,
    { name: string; quantity: number; revenue: number; cost: number }
  >();
  for (const item of items) {
    if (!salesInRange.has(item.saleId)) continue;
    const variant = variants.find((v) => v.id === item.variantId);
    const product = variant ? products.find((p) => p.id === variant.productId) : undefined;
    if (!product) continue;

    const itemRevenue = item.quantity * item.unitPrice - item.discount;
    const itemCost = item.quantity * product.purchasePrice;

    const existing = byProduct.get(product.id) ?? {
      name: product.name,
      quantity: 0,
      revenue: 0,
      cost: 0,
    };
    existing.quantity += item.quantity;
    existing.revenue += itemRevenue;
    existing.cost += itemCost;
    byProduct.set(product.id, existing);
  }

  const withMargin = Array.from(byProduct.entries())
    .map(([productId, v]) => ({
      productId,
      name: v.name,
      quantity: v.quantity,
      revenue: v.revenue,
      cost: v.cost,
      margin: v.revenue - v.cost,
      marginRate: v.revenue > 0 ? ((v.revenue - v.cost) / v.revenue) * 100 : 0,
    }))
    .sort((a, b) => b.margin - a.margin);

  const totalMargin = withMargin.reduce((sum, p) => sum + p.margin, 0);

  let cumulative = 0;
  return withMargin.map((p) => {
    const marginShare = totalMargin > 0 ? (p.margin / totalMargin) * 100 : 0;
    // Classé selon le cumul AVANT ce produit (pas après) : sinon un seul
    // produit dominant (ou celui qui fait franchir le seuil) atterrirait à
    // tort en C simplement parce que son propre cumul dépasse 80/95% — la
    // convention Pareto standard classe plutôt le produit qui FAIT franchir
    // le seuil dans la classe qu'il complète.
    const cumulativeBefore = cumulative;
    cumulative += marginShare;
    const abcClass: "A" | "B" | "C" =
      totalMargin <= 0 ? "C" : cumulativeBefore < 80 ? "A" : cumulativeBefore < 95 ? "B" : "C";
    return { ...p, marginShare, cumulativeShare: cumulative, abcClass };
  });
}

export interface TaxCollectedSummary {
  totalTaxCollected: number;
  salesTaxTotal: number;
  refundsTaxTotal: number;
  taxableRevenue: number;
  byDay: { date: string; taxCollected: number }[];
}

// TVA nette collectée sur la période : la TVA des ventes (déjà extraite du
// prix TTC dans sales.taxTotal, voir SalesService) moins la TVA rendue via
// les remboursements — jamais additionnée au prix, cf. le modèle TVA du
// module Paramètres.
export async function getTaxCollected(
  db: Database,
  range: DateRange,
  storeId?: number,
): Promise<TaxCollectedSummary> {
  const normalized = normalizeRange(range);
  const [sales, refunds] = await Promise.all([listSales(db), db.select().from(schema.refunds)]);

  const salesInRange = sales.filter(
    (s) => inRange(s.createdAt, normalized) && (!storeId || s.storeId === storeId),
  );
  const salesById = new Map(sales.map((s) => [s.id, s] as const));
  // Un remboursement n'a pas de storeId propre — on remonte à la vente
  // d'origine, dont il hérite forcément la boutique (voir RefundsService).
  const refundsInRange = refunds.filter(
    (r) =>
      inRange(r.createdAt, normalized) && (!storeId || salesById.get(r.saleId)?.storeId === storeId),
  );

  const salesTaxTotal = salesInRange.reduce((sum, s) => sum + s.taxTotal, 0);
  const refundsTaxTotal = refundsInRange.reduce((sum, r) => sum + r.taxTotal, 0);
  const taxableRevenue =
    salesInRange.reduce((sum, s) => sum + s.total, 0) - refundsInRange.reduce((sum, r) => sum + r.total, 0);

  const byDayMap = new Map<string, number>();
  for (const sale of salesInRange) {
    const key = dayKey(sale.createdAt);
    byDayMap.set(key, (byDayMap.get(key) ?? 0) + sale.taxTotal);
  }
  for (const refund of refundsInRange) {
    const key = dayKey(refund.createdAt);
    byDayMap.set(key, (byDayMap.get(key) ?? 0) - refund.taxTotal);
  }
  const byDay = Array.from(byDayMap.entries())
    .map(([date, taxCollected]) => ({ date, taxCollected }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalTaxCollected: salesTaxTotal - refundsTaxTotal,
    salesTaxTotal,
    refundsTaxTotal,
    taxableRevenue,
    byDay,
  };
}

export interface CashFlowByMonth {
  month: string;
  cashIn: number;
  cashOut: number;
  net: number;
}

export interface CashFlow {
  byMonth: CashFlowByMonth[];
}

// La trésorerie combine les 5 sources de mouvement d'argent réel : le
// paiement initial d'une vente/d'un achat/d'une dépense (table payments), et
// les remboursements différés de créances/dettes (tables dédiées, jamais
// répercutés dans payments — voir CreditsService/DebtsService).
export async function getCashFlow(db: Database, range: DateRange, storeId?: number): Promise<CashFlow> {
  const normalized = normalizeRange(range);
  const [payments, creditRepayments, debtPayments, credits, debts] = await Promise.all([
    db.select().from(schema.payments),
    db.select().from(schema.creditRepayments),
    db.select().from(schema.supplierDebtPayments),
    db.select().from(schema.customerCredits),
    db.select().from(schema.supplierDebts),
  ]);
  const creditsById = new Map(credits.map((c) => [c.id, c] as const));
  const debtsById = new Map(debts.map((d) => [d.id, d] as const));

  const byMonthMap = new Map<string, { cashIn: number; cashOut: number }>();

  const bump = (createdAt: string, cashIn: number, cashOut: number) => {
    if (!inRange(createdAt, normalized)) return;
    const key = monthKey(createdAt);
    const existing = byMonthMap.get(key) ?? { cashIn: 0, cashOut: 0 };
    existing.cashIn += cashIn;
    existing.cashOut += cashOut;
    byMonthMap.set(key, existing);
  };

  for (const p of payments) {
    if (storeId && p.storeId !== storeId) continue;
    if (p.referenceType === "sale") bump(p.createdAt, p.amount, 0);
    else if (p.referenceType === "service_order") bump(p.createdAt, p.amount, 0);
    else if (p.referenceType === "purchase") bump(p.createdAt, 0, p.amount);
    else if (p.referenceType === "expense") bump(p.createdAt, 0, p.amount);
  }
  // Remboursements de créances/dettes : pas de storeId propre, hérité de la
  // créance/dette d'origine (voir CreditsService/DebtsService).
  for (const r of creditRepayments) {
    if (storeId && creditsById.get(r.creditId)?.storeId !== storeId) continue;
    bump(r.paidAt, r.amount, 0);
  }
  for (const d of debtPayments) {
    if (storeId && debtsById.get(d.debtId)?.storeId !== storeId) continue;
    bump(d.paidAt, 0, d.amount);
  }

  const byMonth = Array.from(byMonthMap.entries())
    .map(([month, v]) => ({ month, cashIn: v.cashIn, cashOut: v.cashOut, net: v.cashIn - v.cashOut }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return { byMonth };
}

export interface CashFlowProjectionYear {
  year: number;
  projectedIn: number;
  projectedOut: number;
  projectedNet: number;
  cumulative: number;
}

export interface CashFlowProjection {
  years: number;
  growthRate: number;
  byYear: CashFlowProjectionYear[];
}

export interface ProjectCashFlowInput {
  years: number;
  growthRate: number;
  storeId?: number;
}

// Extrapolation linéaire : moyenne mensuelle réelle des 12 derniers mois,
// projetée avec un taux de croissance annuel composé fourni par l'utilisateur.
export async function projectCashFlow(
  db: Database,
  input: ProjectCashFlowInput,
): Promise<CashFlowProjection> {
  const now = new Date();
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const { byMonth } = await getCashFlow(
    db,
    {
      from: twelveMonthsAgo.toISOString().slice(0, 10),
      to: now.toISOString().slice(0, 10),
    },
    input.storeId,
  );

  const monthsWithData = byMonth.length || 1;
  const avgIn = byMonth.reduce((sum, m) => sum + m.cashIn, 0) / monthsWithData;
  const avgOut = byMonth.reduce((sum, m) => sum + m.cashOut, 0) / monthsWithData;

  const growthFactor = 1 + input.growthRate / 100;
  let cumulative = 0;
  const byYear: CashFlowProjectionYear[] = [];

  for (let year = 1; year <= input.years; year++) {
    const factor = Math.pow(growthFactor, year - 1);
    const projectedIn = avgIn * 12 * factor;
    const projectedOut = avgOut * 12 * factor;
    const projectedNet = projectedIn - projectedOut;
    cumulative += projectedNet;
    byYear.push({ year, projectedIn, projectedOut, projectedNet, cumulative });
  }

  return { years: input.years, growthRate: input.growthRate, byYear };
}
