import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { eq } from "drizzle-orm";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { listExpenses } from "./ExpensesService";
import { listPurchases } from "./PurchasesService";
import type { DateRange } from "./ReportsService";
import { listSales } from "./SalesService";
import { getSettings } from "./SettingsService";

// Export comptable au référentiel SYSCOHADA révisé (OHADA, zone UEMOA/CFA) —
// reclasse les mêmes données déjà utilisées par AccountingService (revenu,
// coût, charges, trésorerie) selon un plan de comptes et une logique
// débit/crédit, pour produire des journaux exploitables par un cabinet
// comptable local. Optionnel (business_settings.enableSyscohada) et non
// validé pour ce commerce précis tant qu'un comptable n'a pas revu le
// paramétrage (voir l'avertissement affiché dans AccountingPage).
//
// Les NUMÉROS de compte sont entièrement configurables (Paramètres → Export
// comptable SYSCOHADA) car le référentiel OHADA est révisé de temps à
// autre — seul le RÔLE comptable de chaque compte est fixe (ex: "le compte
// Clients", quel que soit son numéro actuel), d'où les libellés ci-dessous
// qui restent constants même quand le numéro change.
type AccountRole =
  | "clients"
  | "fournisseurs"
  | "tvaVentes"
  | "tvaServices"
  | "tvaAchats"
  | "banque"
  | "caisse"
  | "mobileMoney"
  | "achats"
  | "ventes"
  | "services";

export interface SyscohadaAccount {
  code: string;
  label: string;
}

export type SyscohadaAccountSettings = Record<AccountRole, SyscohadaAccount> & {
  defaultExpenseAccount: SyscohadaAccount;
};

async function loadAccountSettings(db: Database): Promise<SyscohadaAccountSettings> {
  const s = await getSettings(db);
  const account = (role: AccountRole, code: string): SyscohadaAccount => ({
    code,
    label: t(`syscohadaRoleLabels.${role}`),
  });
  return {
    clients: account("clients", s.syscohadaAccountClients),
    fournisseurs: account("fournisseurs", s.syscohadaAccountFournisseurs),
    tvaVentes: account("tvaVentes", s.syscohadaAccountTvaVentes),
    tvaServices: account("tvaServices", s.syscohadaAccountTvaServices),
    tvaAchats: account("tvaAchats", s.syscohadaAccountTvaAchats),
    banque: account("banque", s.syscohadaAccountBanque),
    caisse: account("caisse", s.syscohadaAccountCaisse),
    mobileMoney: account("mobileMoney", s.syscohadaAccountMobileMoney),
    achats: account("achats", s.syscohadaAccountAchats),
    ventes: account("ventes", s.syscohadaAccountVentes),
    services: account("services", s.syscohadaAccountServices),
    defaultExpenseAccount: { code: s.syscohadaDefaultExpenseAccountCode, label: s.syscohadaDefaultExpenseAccountLabel },
  };
}

export async function getSyscohadaAccountSettings(db: Database): Promise<SyscohadaAccountSettings> {
  return loadAccountSettings(db);
}

export interface UpdateSyscohadaAccountsInput {
  syscohadaAccountClients?: string;
  syscohadaAccountFournisseurs?: string;
  syscohadaAccountTvaVentes?: string;
  syscohadaAccountTvaServices?: string;
  syscohadaAccountTvaAchats?: string;
  syscohadaAccountBanque?: string;
  syscohadaAccountCaisse?: string;
  syscohadaAccountMobileMoney?: string;
  syscohadaAccountAchats?: string;
  syscohadaAccountVentes?: string;
  syscohadaAccountServices?: string;
  syscohadaDefaultExpenseAccountCode?: string;
  syscohadaDefaultExpenseAccountLabel?: string;
}

// Enregistre les numéros de compte — passe par updateSettings (même table
// singleton business_settings) plutôt que par un service dédié, pour
// bénéficier de la même garde de permission sans la dupliquer.
export async function updateSyscohadaAccounts(
  db: Database,
  input: UpdateSyscohadaAccountsInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_settings");
  await getSettings(db);
  return db
    .update(schema.businessSettings)
    .set(input)
    .where(eq(schema.businessSettings.id, 1))
    .returning()
    .get();
}

export type SyscohadaExpenseAccountMapping = typeof schema.syscohadaExpenseAccounts.$inferSelect;

export async function listExpenseAccountMappings(db: Database): Promise<SyscohadaExpenseAccountMapping[]> {
  return db.select().from(schema.syscohadaExpenseAccounts).orderBy(schema.syscohadaExpenseAccounts.category);
}

// Insère ou met à jour la correspondance d'une catégorie de dépense (texte
// libre, voir expenses.ts) vers un compte de charge — une catégorie n'a
// jamais qu'un seul compte à la fois (category UNIQUE en base).
export async function upsertExpenseAccountMapping(
  db: Database,
  input: { category: string; accountCode: string; accountLabel: string },
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_settings");
  const existing = await db
    .select()
    .from(schema.syscohadaExpenseAccounts)
    .where(eq(schema.syscohadaExpenseAccounts.category, input.category))
    .get();

  if (existing) {
    return db
      .update(schema.syscohadaExpenseAccounts)
      .set({ accountCode: input.accountCode, accountLabel: input.accountLabel })
      .where(eq(schema.syscohadaExpenseAccounts.id, existing.id))
      .returning()
      .get();
  }
  return db.insert(schema.syscohadaExpenseAccounts).values(input).returning().get();
}

export async function deleteExpenseAccountMapping(db: Database, id: number, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_settings");
  await db.delete(schema.syscohadaExpenseAccounts).where(eq(schema.syscohadaExpenseAccounts.id, id));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalizeRange(range: DateRange): DateRange {
  const from = range.from.length === 10 ? `${range.from} 00:00:00` : range.from;
  const to = range.to.length === 10 ? `${range.to} 23:59:59` : range.to;
  return { from, to };
}

function inRange(createdAt: string, range: DateRange): boolean {
  return createdAt >= range.from && createdAt <= range.to;
}

export interface SyscohadaJournalLine {
  date: string; // "YYYY-MM-DD"
  piece: string; // référence : n° de vente/achat/dépense...
  compte: string;
  intitule: string;
  libelle: string;
  debit: number;
  credit: number;
}

function line(date: string, piece: string, account: SyscohadaAccount, libelle: string, debit: number, credit: number): SyscohadaJournalLine {
  return {
    date,
    piece,
    compte: account.code,
    intitule: account.label,
    libelle,
    debit: round2(debit),
    credit: round2(credit),
  };
}

function sortLines(lines: SyscohadaJournalLine[]): SyscohadaJournalLine[] {
  return lines.sort((a, b) => a.date.localeCompare(b.date) || a.piece.localeCompare(b.piece));
}

// Les méthodes de paiement de l'appli ne distinguent pas nativement les
// comptes de trésorerie SYSCOHADA : carte et virement passent tous deux par
// une banque, le Mobile Money est isolé sur son propre compte configurable,
// et tout le reste (espèces, méthode inconnue/"other") retombe sur la caisse.
function treasuryAccount(accounts: SyscohadaAccountSettings, method: string | null | undefined): SyscohadaAccount {
  switch (method) {
    case "card":
    case "bank_transfer":
      return accounts.banque;
    case "mobile_money":
      return accounts.mobileMoney;
    default:
      return accounts.caisse;
  }
}

// Journal des ventes : une pièce par vente (compte "ventes") et par ticket de
// service (compte "services"), plus les avoirs (remboursements). Le
// règlement de chaque vente est ventilé pièce par pièce à partir des lignes
// `payments` réellement enregistrées ; la part non couverte par un paiement
// (vente à crédit ou partiellement réglée) est logée sur le compte Clients —
// de sorte que, pièce par pièce, le total débit égale toujours le total
// crédit.
export async function getJournalVentes(
  db: Database,
  range: DateRange,
  storeId?: number,
): Promise<SyscohadaJournalLine[]> {
  const accounts = await loadAccountSettings(db);
  const normalized = normalizeRange(range);
  const [sales, serviceOrders, allPayments, refunds, customers] = await Promise.all([
    listSales(db),
    db.select().from(schema.serviceOrders),
    db.select().from(schema.payments),
    db.select().from(schema.refunds),
    db.select().from(schema.customers),
  ]);

  const customersById = new Map(customers.map((c) => [c.id, c] as const));
  const customerLabel = (customerId: number | null) =>
    customerId
      ? (customersById.get(customerId)?.fullName ?? t("syscohadaLabels.customerFallback"))
      : t("syscohadaLabels.walkInCustomer");

  const paymentsByRef = new Map<string, typeof allPayments>();
  for (const p of allPayments) {
    const key = `${p.referenceType}:${p.referenceId}`;
    const arr = paymentsByRef.get(key) ?? [];
    arr.push(p);
    paymentsByRef.set(key, arr);
  }

  const lines: SyscohadaJournalLine[] = [];

  for (const sale of sales) {
    if (sale.status === "cancelled" || sale.status === "draft") continue;
    if (storeId && sale.storeId !== storeId) continue;
    if (!inRange(sale.createdAt, normalized)) continue;

    const date = sale.createdAt.slice(0, 10);
    const libelle = t("syscohadaLabels.sale", { number: sale.number, customer: customerLabel(sale.customerId) });
    const ht = sale.subtotal - sale.discount;

    const salePayments = paymentsByRef.get(`sale:${sale.id}`) ?? [];
    const paidTotal = salePayments.reduce((sum, p) => sum + p.amount, 0);
    for (const p of salePayments) {
      lines.push(line(p.createdAt.slice(0, 10), sale.number, treasuryAccount(accounts, p.method), libelle, p.amount, 0));
    }
    const creditPortion = round2(sale.total - paidTotal);
    if (creditPortion > 0.01) lines.push(line(date, sale.number, accounts.clients, libelle, creditPortion, 0));

    if (ht > 0) lines.push(line(date, sale.number, accounts.ventes, libelle, 0, ht));
    if (sale.taxTotal > 0) lines.push(line(date, sale.number, accounts.tvaVentes, libelle, 0, sale.taxTotal));
  }

  for (const so of serviceOrders) {
    if (storeId && so.storeId !== storeId) continue;
    if (!inRange(so.createdAt, normalized)) continue;

    const date = so.createdAt.slice(0, 10);
    const libelle = t("syscohadaLabels.serviceTicket", {
      number: so.number,
      customer: customerLabel(so.customerId),
    });
    const ht = so.subtotal - so.discount;

    const soPayments = paymentsByRef.get(`service_order:${so.id}`) ?? [];
    const paidTotal = soPayments.reduce((sum, p) => sum + p.amount, 0);
    for (const p of soPayments) {
      lines.push(line(p.createdAt.slice(0, 10), so.number, treasuryAccount(accounts, p.method), libelle, p.amount, 0));
    }
    const creditPortion = round2(so.total - paidTotal);
    if (creditPortion > 0.01) lines.push(line(date, so.number, accounts.clients, libelle, creditPortion, 0));

    if (ht > 0) lines.push(line(date, so.number, accounts.services, libelle, 0, ht));
    if (so.taxTotal > 0) lines.push(line(date, so.number, accounts.tvaServices, libelle, 0, so.taxTotal));
  }

  const salesById = new Map(sales.map((s) => [s.id, s] as const));
  for (const refund of refunds) {
    const sale = salesById.get(refund.saleId);
    if (storeId && sale && sale.storeId !== storeId) continue;
    if (!inRange(refund.createdAt, normalized)) continue;

    const date = refund.createdAt.slice(0, 10);
    const piece = `AV-${sale?.number ?? refund.saleId}`;
    const libelle = t("syscohadaLabels.saleRefund", { number: sale?.number ?? refund.saleId });

    if (refund.subtotal > 0) lines.push(line(date, piece, accounts.ventes, libelle, refund.subtotal, 0));
    if (refund.taxTotal > 0) lines.push(line(date, piece, accounts.tvaVentes, libelle, refund.taxTotal, 0));
    if (refund.total > 0) lines.push(line(date, piece, treasuryAccount(accounts, refund.method), libelle, 0, refund.total));
  }

  return sortLines(lines);
}

// Journal des achats — seuls les achats réceptionnés (status "received")
// constatent une charge réelle ; une commande non encore livrée n'est pas
// encore une dette ni un stock. Aucune TVA déductible n'est calculée : le
// schéma actuel n'enregistre pas de taux de TVA sur les achats (contrairement
// aux ventes) — chaque montant est donc porté sur le compte "achats" pour son
// total intégral, à corriger manuellement si le fournisseur facture de la
// TVA récupérable.
export async function getJournalAchats(
  db: Database,
  range: DateRange,
  storeId?: number,
): Promise<SyscohadaJournalLine[]> {
  const accounts = await loadAccountSettings(db);
  const normalized = normalizeRange(range);
  const [purchases, allPayments, suppliers, debts] = await Promise.all([
    listPurchases(db),
    db.select().from(schema.payments),
    db.select().from(schema.suppliers),
    db.select().from(schema.supplierDebts),
  ]);

  const suppliersById = new Map(suppliers.map((s) => [s.id, s] as const));
  const debtByPurchase = new Map(
    debts.filter((d) => d.purchaseId != null).map((d) => [d.purchaseId as number, d] as const),
  );
  const paymentsByPurchase = new Map<number, typeof allPayments>();
  for (const p of allPayments) {
    if (p.referenceType !== "purchase") continue;
    const arr = paymentsByPurchase.get(p.referenceId) ?? [];
    arr.push(p);
    paymentsByPurchase.set(p.referenceId, arr);
  }

  const lines: SyscohadaJournalLine[] = [];

  for (const purchase of purchases) {
    if (purchase.status !== "received") continue;
    if (storeId && purchase.storeId !== storeId) continue;
    if (!inRange(purchase.createdAt, normalized)) continue;

    const date = purchase.createdAt.slice(0, 10);
    const supplierLabel = suppliersById.get(purchase.supplierId)?.name ?? t("syscohadaLabels.supplierFallback");
    const libelle = t("syscohadaLabels.purchase", { number: purchase.number, supplier: supplierLabel });

    lines.push(line(date, purchase.number, accounts.achats, libelle, purchase.total, 0));

    const purchasePayments = paymentsByPurchase.get(purchase.id) ?? [];
    const paidTotal = purchasePayments.reduce((sum, p) => sum + p.amount, 0);
    for (const p of purchasePayments) {
      lines.push(
        line(p.createdAt.slice(0, 10), purchase.number, treasuryAccount(accounts, p.method), libelle, 0, p.amount),
      );
    }
    const debt = debtByPurchase.get(purchase.id);
    const creditPortion = debt ? debt.originalAmount : round2(Math.max(0, purchase.total - paidTotal));
    if (creditPortion > 0.01) lines.push(line(date, purchase.number, accounts.fournisseurs, libelle, 0, creditPortion));
  }

  return sortLines(lines);
}

// Journal de trésorerie — mouvements d'argent qui ne sont pas déjà
// représentés dans le journal des ventes/achats : dépenses, règlements
// différés de créances clients et de dettes fournisseurs. Les remboursements
// de dettes fournisseurs (supplierDebtPayments) n'ont pas de méthode de
// paiement enregistrée dans le schéma actuel — portés sur le compte caisse
// par défaut, à ajuster si le règlement a en réalité transité par une banque.
export async function getJournalTresorerie(
  db: Database,
  range: DateRange,
  storeId?: number,
): Promise<SyscohadaJournalLine[]> {
  const accounts = await loadAccountSettings(db);
  const normalized = normalizeRange(range);
  const [expenseRows, expenseMappings, creditRepayments, debtPayments, credits, debts, customers, suppliers] =
    await Promise.all([
      listExpenses(db, { from: range.from.slice(0, 10), to: range.to.slice(0, 10), storeId }),
      db.select().from(schema.syscohadaExpenseAccounts),
      db.select().from(schema.creditRepayments),
      db.select().from(schema.supplierDebtPayments),
      db.select().from(schema.customerCredits),
      db.select().from(schema.supplierDebts),
      db.select().from(schema.customers),
      db.select().from(schema.suppliers),
    ]);

  const expenseAccountByCategory = new Map(expenseMappings.map((m) => [m.category, m] as const));
  const creditsById = new Map(credits.map((c) => [c.id, c] as const));
  const debtsById = new Map(debts.map((d) => [d.id, d] as const));
  const customersById = new Map(customers.map((c) => [c.id, c] as const));
  const suppliersById = new Map(suppliers.map((s) => [s.id, s] as const));

  const lines: SyscohadaJournalLine[] = [];

  for (const e of expenseRows) {
    const piece = `DEP-${e.id}`;
    const libelle = e.note ? `${e.category} — ${e.note}` : e.category;
    const mapping = expenseAccountByCategory.get(e.category);
    const account: SyscohadaAccount = mapping
      ? { code: mapping.accountCode, label: mapping.accountLabel }
      : accounts.defaultExpenseAccount;
    lines.push(line(e.expenseDate, piece, account, libelle, e.amount, 0));
    lines.push(line(e.expenseDate, piece, treasuryAccount(accounts, e.paymentMethod), libelle, 0, e.amount));
  }

  for (const r of creditRepayments) {
    const credit = creditsById.get(r.creditId);
    if (storeId && credit?.storeId !== storeId) continue;
    if (!inRange(r.paidAt, normalized)) continue;

    const date = r.paidAt.slice(0, 10);
    const piece = `REG-C${r.creditId}`;
    const label = credit?.customerId
      ? (customersById.get(credit.customerId)?.fullName ?? t("syscohadaLabels.customerFallback"))
      : t("syscohadaLabels.customerFallback");
    const libelle = t("syscohadaLabels.creditRepayment", { label });
    lines.push(line(date, piece, treasuryAccount(accounts, r.method), libelle, r.amount, 0));
    lines.push(line(date, piece, accounts.clients, libelle, 0, r.amount));
  }

  for (const d of debtPayments) {
    const debt = debtsById.get(d.debtId);
    if (storeId && debt?.storeId !== storeId) continue;
    if (!inRange(d.paidAt, normalized)) continue;

    const date = d.paidAt.slice(0, 10);
    const piece = `REG-F${d.debtId}`;
    const label = debt?.supplierId
      ? (suppliersById.get(debt.supplierId)?.name ?? t("syscohadaLabels.supplierFallback"))
      : t("syscohadaLabels.supplierFallback");
    const libelle = t("syscohadaLabels.debtRepayment", { label });
    lines.push(line(date, piece, accounts.fournisseurs, libelle, d.amount, 0));
    lines.push(line(date, piece, accounts.caisse, libelle, 0, d.amount));
  }

  return sortLines(lines);
}

export interface SyscohadaBalanceRow {
  compte: string;
  intitule: string;
  debit: number;
  credit: number;
  solde: number; // débit - crédit (positif = solde débiteur)
}

// Balance générale : agrégation par compte des trois journaux ci-dessus — le
// document de base qu'un cabinet comptable utilise pour reconstituer le bilan
// et le compte de résultat SYSCOHADA (classes 1-5 → bilan, classes 6-7 →
// compte de résultat), ou pour l'importer directement dans un logiciel
// comptable (Sage, Ciel...).
export async function getBalanceGenerale(
  db: Database,
  range: DateRange,
  storeId?: number,
): Promise<SyscohadaBalanceRow[]> {
  const [ventes, achats, tresorerie] = await Promise.all([
    getJournalVentes(db, range, storeId),
    getJournalAchats(db, range, storeId),
    getJournalTresorerie(db, range, storeId),
  ]);

  const byAccount = new Map<string, { intitule: string; debit: number; credit: number }>();
  for (const l of [...ventes, ...achats, ...tresorerie]) {
    const existing = byAccount.get(l.compte) ?? { intitule: l.intitule, debit: 0, credit: 0 };
    existing.debit += l.debit;
    existing.credit += l.credit;
    byAccount.set(l.compte, existing);
  }

  return Array.from(byAccount.entries())
    .map(([compte, v]) => ({
      compte,
      intitule: v.intitule,
      debit: round2(v.debit),
      credit: round2(v.credit),
      solde: round2(v.debit - v.credit),
    }))
    .sort((a, b) => a.compte.localeCompare(b.compte));
}
