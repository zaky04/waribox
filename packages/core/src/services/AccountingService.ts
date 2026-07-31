import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { listExpenses } from "./ExpensesService";
import { listAllVariants, listProducts } from "./ProductsService";
import { getCashFlow, getMarginsSummary, type DateRange } from "./ReportsService";
import { getStockLevels } from "./StockService";

export interface IncomeStatement {
  from: string;
  to: string;
  salesRevenue: number;
  serviceRevenue: number;
  revenue: number;
  cogs: number;
  expensesTotal: number;
  expensesByCategory: { category: string; amount: number }[];
  netIncome: number;
}

// Compte de résultat simplifié : pas de plan comptable, pas de débit/crédit —
// une simple agrégation revenu - coût des ventes - charges, dans l'esprit de
// getCashFlow/getMarginsSummary déjà existants.
export async function getIncomeStatement(db: Database, range: DateRange): Promise<IncomeStatement> {
  const from10 = range.from.slice(0, 10);
  const to10 = range.to.slice(0, 10);

  const [margins, serviceOrders, expenseRows] = await Promise.all([
    getMarginsSummary(db, range),
    db.select().from(schema.serviceOrders),
    listExpenses(db, { from: from10, to: to10 }),
  ]);

  // serviceOrders.total est TTC (voir ServiceOrdersService.createServiceOrder,
  // total = subtotal - discount + taxTotal) alors que margins.revenue est HT
  // (quantity*unitPrice - discount, hors taxe). On soustrait taxTotal pour
  // rester sur la même base HT que le reste du compte de résultat — sinon le
  // CA serait gonflé du montant de la TVA des tickets de service.
  //
  // Les tickets de service n'ont par ailleurs aucun coût de revient
  // traçable : leurs articles sont saisis en texte libre
  // (service_order_items.description), sans lien avec le catalogue Produits
  // — ils contribuent donc au revenu mais jamais au COGS. Approximation
  // volontaire assumée, documentée plutôt que masquée (comme
  // getMarginsSummary le fait déjà pour purchasePrice).
  const serviceRevenue = serviceOrders
    .filter((so) => so.createdAt.slice(0, 10) >= from10 && so.createdAt.slice(0, 10) <= to10)
    .reduce((sum, so) => sum + (so.total - so.taxTotal), 0);

  const salesRevenue = margins.revenue;
  const revenue = salesRevenue + serviceRevenue;
  const cogs = margins.cost;

  const byCategory = new Map<string, number>();
  for (const e of expenseRows) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount);
  const expensesByCategory = Array.from(byCategory.entries()).map(([category, amount]) => ({
    category,
    amount,
  }));
  const expensesTotal = expenseRows.reduce((sum, e) => sum + e.amount, 0);

  const netIncome = revenue - cogs - expensesTotal;

  return {
    from: range.from,
    to: range.to,
    salesRevenue,
    serviceRevenue,
    revenue,
    cogs,
    expensesTotal,
    expensesByCategory,
    netIncome,
  };
}

export interface BalanceSheet {
  asOfDate: string;
  cash: number;
  stockValue: number;
  receivables: number;
  actifTotal: number;
  payables: number;
  passifTotal: number;
  equity: number;
}

// Bilan simplifié — vue managériale, pas un bilan certifié. Seule la
// trésorerie est réellement reconstituée "à la date" (cumul des flux) ; le
// stock, les créances et les dettes sont des soldes VIVANTS (aucun mécanisme
// d'historisation dans le schéma actuel), donc ces trois postes reflètent
// toujours l'état courant, même si asOfDate est une date passée. C'est
// pourquoi AccountingPage n'expose pas de sélecteur de date sur l'onglet
// Bilan — pour éviter une fausse précision.
export async function getBalanceSheet(db: Database, asOfDate: string): Promise<BalanceSheet> {
  const [cashFlowSinceOrigin, levels, variants, products, credits, debts] = await Promise.all([
    getCashFlow(db, { from: "1970-01-01", to: asOfDate }),
    getStockLevels(db),
    listAllVariants(db),
    listProducts(db),
    db.select().from(schema.customerCredits),
    db.select().from(schema.supplierDebts),
  ]);

  // Trésorerie approximée par le cumul net de tous les flux de paiement
  // enregistrés depuis l'origine — ne tient pas compte d'un premier fonds de
  // caisse injecté par le propriétaire hors du système (jamais un "payment").
  const cash = cashFlowSinceOrigin.byMonth.reduce((sum, m) => sum + m.net, 0);

  const stockValue = levels.reduce((sum, level) => {
    const variant = variants.find((v) => v.id === level.variantId);
    const product = variant ? products.find((p) => p.id === variant.productId) : undefined;
    return sum + (product ? level.quantity * product.purchasePrice : 0);
  }, 0);

  const receivables = credits
    .filter((c) => c.status !== "settled")
    .reduce((sum, c) => sum + c.remainingBalance, 0);
  const payables = debts
    .filter((d) => d.status !== "settled")
    .reduce((sum, d) => sum + d.remainingBalance, 0);

  const actifTotal = cash + stockValue + receivables;
  const passifTotal = payables;
  const equity = actifTotal - passifTotal; // résiduel, pas un compte de capitaux propres suivi

  return { asOfDate, cash, stockValue, receivables, actifTotal, payables, passifTotal, equity };
}
