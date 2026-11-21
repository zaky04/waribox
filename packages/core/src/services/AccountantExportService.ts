import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { localDayEndUtc, localDayStartUtc } from "../domain/localDay";
import { roundMoney } from "../domain/money";
import { getTaxCollected } from "./ReportsService";

// Dossier pour l'expert-comptable : tout ce qui s'est passé sur la période, en tableaux simples (une ligne par
// opération, montants bruts, dates locales) qu'il peut reprendre dans son propre logiciel. Ce n'est pas un journal
// comptable (voir l'export SYSCOHADA pour cela) : ce sont les PIÈCES, dans l'ordre, sans interprétation.

export interface AccountantSheet {
  name: string;
  rows: Record<string, unknown>[];
}

export interface AccountantExport {
  from: string;
  to: string;
  sheets: AccountantSheet[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** « 2026-11-20 14:32 » en heure locale, à partir d'un horodatage enregistré en UTC. */
export function localDateTime(createdAt: string | null | undefined): string {
  if (!createdAt) return "";
  const d = new Date(createdAt.includes("T") ? createdAt : createdAt.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return createdAt;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const methodLabel = (method: string) => t(`sales.paymentMethods.${method}`, { defaultValue: method });

export async function buildAccountantExport(db: Database, range: { from: string; to: string }, storeId?: number): Promise<AccountantExport> {
  const from = range.from.slice(0, 10);
  const to = range.to.slice(0, 10);
  const utcFrom = localDayStartUtc(from);
  const utcTo = localDayEndUtc(to);
  const col = (key: string) => t(`accountantExport.columns.${key}`);

  const saleConditions = [gte(schema.sales.createdAt, utcFrom), lte(schema.sales.createdAt, utcTo)];
  if (storeId) saleConditions.push(eq(schema.sales.storeId, storeId));
  const purchaseConditions = [gte(schema.purchases.createdAt, utcFrom), lte(schema.purchases.createdAt, utcTo)];
  if (storeId) purchaseConditions.push(eq(schema.purchases.storeId, storeId));
  const expenseConditions = [gte(schema.expenses.expenseDate, from), lte(schema.expenses.expenseDate, to)];
  if (storeId) expenseConditions.push(eq(schema.expenses.storeId, storeId));

  const [sales, refunds, purchases, expenses, repayments, openCredits, customers, suppliers, tax] = await Promise.all([
    db.select().from(schema.sales).where(and(...saleConditions)).orderBy(schema.sales.createdAt),
    db.select().from(schema.refunds).where(and(gte(schema.refunds.createdAt, utcFrom), lte(schema.refunds.createdAt, utcTo))).orderBy(schema.refunds.createdAt),
    db.select().from(schema.purchases).where(and(...purchaseConditions)).orderBy(schema.purchases.createdAt),
    db.select().from(schema.expenses).where(and(...expenseConditions)).orderBy(schema.expenses.expenseDate),
    db.select().from(schema.creditRepayments).where(and(gte(schema.creditRepayments.paidAt, utcFrom), lte(schema.creditRepayments.paidAt, utcTo))).orderBy(schema.creditRepayments.paidAt),
    db.select().from(schema.customerCredits).where(and(ne(schema.customerCredits.status, "settled"))),
    db.select({ id: schema.customers.id, fullName: schema.customers.fullName }).from(schema.customers),
    db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers),
    getTaxCollected(db, { from, to }, storeId),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, c.fullName] as const));
  const repaidCredits = repayments.length > 0 ? await db.select().from(schema.customerCredits).where(inArray(schema.customerCredits.id, [...new Set(repayments.map((r) => r.creditId))])) : [];
  const customerOfCredit = new Map(repaidCredits.map((c) => [c.id, c.customerId] as const));
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name] as const));

  // Modes de paiement des ventes et sommes payées des achats, en une seule lecture.
  const salePayments = sales.length > 0 ? await db.select().from(schema.payments).where(and(eq(schema.payments.referenceType, "sale"), inArray(schema.payments.referenceId, sales.map((s) => s.id)))) : [];
  const purchasePayments = purchases.length > 0 ? await db.select().from(schema.payments).where(and(eq(schema.payments.referenceType, "purchase"), inArray(schema.payments.referenceId, purchases.map((p) => p.id)))) : [];
  const methodsOfSale = new Map<number, string[]>();
  for (const p of salePayments) methodsOfSale.set(p.referenceId, [...(methodsOfSale.get(p.referenceId) ?? []), methodLabel(p.method)]);
  const paidOfPurchase = new Map<number, number>();
  for (const p of purchasePayments) paidOfPurchase.set(p.referenceId, (paidOfPurchase.get(p.referenceId) ?? 0) + p.amount);
  const saleNumber = new Map<number, string>();
  if (refunds.length > 0) {
    for (const s of await db.select({ id: schema.sales.id, number: schema.sales.number }).from(schema.sales).where(inArray(schema.sales.id, refunds.map((r) => r.saleId)))) saleNumber.set(s.id, s.number);
  }

  const validSales = sales.filter((s) => s.status !== "cancelled");
  const salesTotal = roundMoney(validSales.reduce((sum, s) => sum + s.total, 0));
  const refundsTotal = roundMoney(refunds.reduce((sum, r) => sum + r.total, 0));
  const purchasesTotal = roundMoney(purchases.filter((p) => p.status !== "cancelled").reduce((sum, p) => sum + p.total, 0));
  const expensesTotal = roundMoney(expenses.reduce((sum, e) => sum + e.amount, 0));
  const creditsRemaining = roundMoney(openCredits.reduce((sum, c) => sum + c.remainingBalance, 0));

  const sheets: AccountantSheet[] = [
    {
      name: t("accountantExport.sheets.summary"),
      rows: [
        { [col("label")]: t("accountantExport.summary.period"), [col("amount")]: `${from} → ${to}` },
        { [col("label")]: t("accountantExport.summary.sales"), [col("amount")]: salesTotal },
        { [col("label")]: t("accountantExport.summary.refunds"), [col("amount")]: refundsTotal },
        { [col("label")]: t("accountantExport.summary.netSales"), [col("amount")]: roundMoney(salesTotal - refundsTotal) },
        { [col("label")]: t("accountantExport.summary.tax"), [col("amount")]: roundMoney(tax.totalTaxCollected) },
        { [col("label")]: t("accountantExport.summary.purchases"), [col("amount")]: purchasesTotal },
        { [col("label")]: t("accountantExport.summary.expenses"), [col("amount")]: expensesTotal },
        { [col("label")]: t("accountantExport.summary.repayments"), [col("amount")]: roundMoney(repayments.reduce((sum, r) => sum + r.amount, 0)) },
        { [col("label")]: t("accountantExport.summary.creditsOpen"), [col("amount")]: creditsRemaining },
      ],
    },
    {
      name: t("accountantExport.sheets.sales"),
      rows: sales.map((s) => ({
        [col("date")]: localDateTime(s.createdAt),
        [col("number")]: s.number,
        [col("customer")]: s.customerId != null ? (customerName.get(s.customerId) ?? "") : "",
        [col("total")]: s.total,
        [col("tax")]: s.taxTotal,
        [col("discount")]: s.discount,
        [col("status")]: s.status === "cancelled" ? t("accountantExport.cancelled") : t(`common.paymentStatus.${s.paymentStatus}`, { defaultValue: s.paymentStatus }),
        [col("method")]: (methodsOfSale.get(s.id) ?? (s.paymentStatus === "credit" ? [methodLabel("credit")] : [])).join(" + "),
        [col("fneReference")]: s.fneReference ?? "",
      })),
    },
    {
      name: t("accountantExport.sheets.refunds"),
      rows: refunds.map((r) => ({
        [col("date")]: localDateTime(r.createdAt),
        [col("sale")]: saleNumber.get(r.saleId) ?? "",
        [col("total")]: r.total,
        [col("tax")]: r.taxTotal,
        [col("method")]: methodLabel(r.method),
        [col("reason")]: r.reason ?? "",
      })),
    },
    {
      name: t("accountantExport.sheets.purchases"),
      rows: purchases.map((p) => ({
        [col("date")]: localDateTime(p.createdAt),
        [col("number")]: p.number,
        [col("invoice")]: p.invoiceReference ?? "",
        [col("supplier")]: supplierName.get(p.supplierId) ?? "",
        [col("total")]: p.total,
        [col("paid")]: roundMoney(paidOfPurchase.get(p.id) ?? 0),
        [col("status")]: p.status,
      })),
    },
    {
      name: t("accountantExport.sheets.expenses"),
      rows: expenses.map((e) => ({
        [col("date")]: e.expenseDate,
        [col("category")]: e.category,
        [col("note")]: e.note ?? "",
        [col("amount")]: e.amount,
        [col("method")]: e.paymentMethod ? methodLabel(e.paymentMethod) : "",
      })),
    },
    {
      name: t("accountantExport.sheets.repayments"),
      rows: repayments.map((r) => ({
        [col("date")]: localDateTime(r.paidAt),
        [col("customer")]: customerName.get(customerOfCredit.get(r.creditId) ?? -1) ?? "",
        [col("amount")]: r.amount,
        [col("method")]: r.method ? methodLabel(r.method) : "",
      })),
    },
    {
      name: t("accountantExport.sheets.openCredits"),
      rows: openCredits.map((c) => ({
        [col("customer")]: customerName.get(c.customerId) ?? "",
        [col("date")]: localDateTime(c.createdAt),
        [col("dueDate")]: c.dueDate ?? "",
        [col("original")]: c.originalAmount,
        [col("remaining")]: c.remainingBalance,
      })),
    },
    {
      name: t("accountantExport.sheets.tax"),
      rows: tax.byDay.map((d) => ({ [col("date")]: d.date, [col("tax")]: roundMoney(d.taxCollected) })),
    },
  ];
  return { from, to, sheets };
}
