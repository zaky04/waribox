import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { formatAmount, t } from "@gestion-boutique/i18n";
import { eq } from "drizzle-orm";
import { verifyPin } from "../auth/AuthService";
import { roundMoney } from "../domain/money";
import { applyOverrides, hasPermission, parseOverrides, type Permission, type PermissionSet } from "../domain/permissions";
import { logAction } from "./AuditService";
import { getSettings } from "./SettingsService";

// Approbation d'un responsable pour les actions sensibles (remboursement, perte
// ou entrée manuelle de stock, vente à crédit) qui dépassent un plafond : le
// responsable saisit son code PIN sur l'appareil de l'employé. Les seuils
// viennent des paramètres (globaux) ou du plafond personnel de l'utilisateur.
// NULL = pas de contrôle ; 0 = toute action de ce type exige une approbation.
export type ApprovalKind = "refund" | "stock" | "credit" | "discount" | "expense" | "points" | "ticket";

// Droit d'approuver chaque domaine (en plus du droit général approve_actions) :
// le propriétaire peut ainsi confier, par exemple, les remises à un gérant de
// confiance sans lui donner l'approbation du stock.
export const APPROVAL_PERMISSION: Record<ApprovalKind, Permission> = {
  refund: "approve_refunds",
  stock: "approve_stock",
  credit: "approve_credit",
  discount: "approve_discounts",
  expense: "approve_expenses",
  points: "approve_points",
  ticket: "approve_tickets",
};

export function canApprove(permissions: PermissionSet, kind: ApprovalKind): boolean {
  return hasPermission(permissions, "approve_actions") || hasPermission(permissions, APPROVAL_PERMISSION[kind]);
}

function canApproveAnything(permissions: PermissionSet): boolean {
  return hasPermission(permissions, "approve_actions") || (Object.values(APPROVAL_PERMISSION) as Permission[]).some((p) => hasPermission(permissions, p));
}

// Un montant de points n'est pas un montant d'argent.
function formatApprovalValue(kind: ApprovalKind, value: number): string {
  return kind === "points" ? String(Math.round(value)) : formatAmount(value);
}

export interface ApprovalInput {
  approverId: number;
  pin: string;
}

export class ApprovalRequiredError extends Error {
  kind: ApprovalKind;
  amount: number;
  threshold: number;
  constructor(kind: ApprovalKind, amount: number, threshold: number) {
    super(
      t(kind === "points" ? "coreErrors.approval.requiredPoints" : "coreErrors.approval.required", {
        kind: t(`approval.kinds.${kind}`),
        amount: formatApprovalValue(kind, amount),
        threshold: formatApprovalValue(kind, threshold),
      }),
    );
    this.name = "ApprovalRequiredError";
    this.kind = kind;
    this.amount = amount;
    this.threshold = threshold;
  }
}

// Refus d'une approbation fournie (responsable invalide, code incorrect) —
// distinct de ApprovalRequiredError pour que l'UI redemande la saisie.
export class ApprovalDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalDeniedError";
  }
}

// Le plafond personnel prime sur le seuil global.
export function pickThreshold(userLimit: number | null | undefined, globalThreshold: number | null | undefined): number | null {
  if (userLimit != null) return userLimit;
  return globalThreshold ?? null;
}

export function exceedsThreshold(amount: number, threshold: number | null): boolean {
  return threshold != null && amount > threshold;
}

async function loadApprover(db: Database, approverId: number) {
  const row = await db
    .select({ id: schema.users.id, isActive: schema.users.isActive, permissions: schema.roles.permissions, overrides: schema.users.permissionOverrides })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.users.id, approverId))
    .get();
  if (!row || !row.isActive) return undefined;
  const perms = applyOverrides(JSON.parse(row.permissions) as PermissionSet, parseOverrides(row.overrides));
  return canApproveAnything(perms) ? { id: row.id, perms } : undefined;
}

// Le responsable vérifié a-t-il le droit d'approuver CE domaine ? (lecture seule)
async function approverCanApprove(db: Database, approverId: number, kind: ApprovalKind): Promise<boolean> {
  const approver = await loadApprover(db, approverId);
  return !!approver && canApprove(approver.perms, kind);
}

// Utilisateurs actifs pouvant approuver (et ayant un code PIN) — pour la fenêtre
// de saisie de l'approbation.
export async function listApprovers(db: Database, kind?: ApprovalKind): Promise<{ id: number; fullName: string }[]> {
  const rows = await db
    .select({
      id: schema.users.id,
      fullName: schema.users.fullName,
      isActive: schema.users.isActive,
      pinHash: schema.users.pinHash,
      permissions: schema.roles.permissions,
      overrides: schema.users.permissionOverrides,
    })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId));
  return rows
    .filter((r) => {
      if (!r.isActive || !r.pinHash) return false;
      const perms = applyOverrides(JSON.parse(r.permissions) as PermissionSet, parseOverrides(r.overrides));
      return kind ? canApprove(perms, kind) : canApproveAnything(perms);
    })
    .map((r) => ({ id: r.id, fullName: r.fullName }));
}

// Vérifie le code du responsable fourni (s'il y en a un) et retourne son id.
// À faire HORS de toute transaction : un code faux incrémente le compteur
// d'essais du responsable, qui doit survivre à un rollback.
export async function verifyApprovalInput(
  db: Database,
  userId: number | undefined,
  approval: ApprovalInput | undefined,
): Promise<number | null> {
  if (!approval) return null;
  const approver = await loadApprover(db, approval.approverId);
  if (!approver || approver.id === userId) throw new ApprovalDeniedError(t("coreErrors.approval.invalidApprover"));

  const valid = await verifyPin(db, approver.id, approval.pin);
  if (!valid) {
    await logAction(db, {
      userId: userId ?? null,
      action: "approval_failed",
      entity: "approval",
      entityId: approver.id,
      metadata: {},
    });
    throw new ApprovalDeniedError(t("coreErrors.approval.wrongPin"));
  }
  return approver.id;
}

export interface CheckApprovalInput {
  kind: ApprovalKind;
  amount: number;
  userId?: number;
  actingPermissions: PermissionSet;
  // Responsable déjà vérifié par verifyApprovalInput.
  verifiedApproverId?: number | null;
  // Plafond supplémentaire (ex. marge de crédit restante du client) : le plus
  // bas entre lui et le seuil habituel s'applique.
  thresholdOverride?: number;
}

// Lecture seule (sans effet d'écriture) : peut donc s'exécuter dans une
// transaction. Lève ApprovalRequiredError si l'action dépasse le plafond et
// qu'aucun responsable vérifié n'est fourni ; sinon retourne l'id du
// responsable à enregistrer avec l'action (null si aucune approbation utile).
export async function checkApproval(db: Database, input: CheckApprovalInput): Promise<number | null> {
  if (canApprove(input.actingPermissions, input.kind)) return null;

  const settings = await getSettings(db);
  const globalThresholds: Record<ApprovalKind, number | null | undefined> = {
    refund: settings.approvalRefundThreshold,
    stock: settings.approvalStockThreshold,
    credit: settings.approvalCreditThreshold,
    discount: settings.approvalDiscountThreshold,
    expense: settings.approvalExpenseThreshold,
    points: settings.approvalPointsThreshold,
    ticket: settings.approvalTicketThreshold,
  };
  const globalThreshold = globalThresholds[input.kind];

  let userLimit: number | null = null;
  if (input.userId != null) {
    const user = await db
      .select({
        limitRefund: schema.users.limitRefund,
        limitStock: schema.users.limitStock,
        limitCredit: schema.users.limitCredit,
        limitDiscount: schema.users.limitDiscount,
        limitExpense: schema.users.limitExpense,
        limitPoints: schema.users.limitPoints,
        limitTicket: schema.users.limitTicket,
      })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .get();
    const limits: Record<ApprovalKind, number | null | undefined> = {
      refund: user?.limitRefund,
      stock: user?.limitStock,
      credit: user?.limitCredit,
      discount: user?.limitDiscount,
      expense: user?.limitExpense,
      points: user?.limitPoints,
      ticket: user?.limitTicket,
    };
    userLimit = limits[input.kind] ?? null;
  }

  let threshold = pickThreshold(userLimit, globalThreshold);
  if (input.thresholdOverride != null) {
    threshold = threshold == null ? input.thresholdOverride : Math.min(threshold, input.thresholdOverride);
  }
  if (!exceedsThreshold(input.amount, threshold)) return null;
  if (input.verifiedApproverId == null) throw new ApprovalRequiredError(input.kind, input.amount, threshold!);
  // Le responsable a fourni un code valide : il doit aussi avoir le droit
  // d'approuver CE domaine (ex. approuver les remises n'autorise pas le stock).
  if (!(await approverCanApprove(db, input.verifiedApproverId, input.kind))) {
    throw new ApprovalDeniedError(t("coreErrors.approval.invalidApprover"));
  }
  return input.verifiedApproverId;
}

export interface RequireApprovalInput {
  kind: ApprovalKind;
  amount: number;
  userId?: number;
  actingPermissions: PermissionSet;
  approval?: ApprovalInput;
}

// Version tout-en-un pour les actions sans transaction englobante (stock).
export async function requireApproval(db: Database, input: RequireApprovalInput): Promise<number | null> {
  if (canApprove(input.actingPermissions, input.kind)) return null;
  const verifiedApproverId = await verifyApprovalInput(db, input.userId, input.approval);
  return checkApproval(db, { ...input, verifiedApproverId });
}

// Encours de crédit d'un client (créances non soldées, ventes et tickets confondus).
export async function getOutstandingCredit(db: Database, customerId: number): Promise<number> {
  const rows = await db
    .select({ remaining: schema.customerCredits.remainingBalance, status: schema.customerCredits.status })
    .from(schema.customerCredits)
    .where(eq(schema.customerCredits.customerId, customerId));
  return rows.filter((r) => r.status !== "settled").reduce((sum, r) => sum + r.remaining, 0);
}

// Contrôle d'une vente/d'un ticket à crédit : plafond du client (ou par défaut)
// et seuil d'approbation. Retourne le responsable ayant approuvé, le cas échéant.
export async function checkCreditApproval(
  db: Database,
  input: {
    customerId: number;
    creditAmount: number;
    userId?: number;
    actingPermissions: PermissionSet;
    verifiedApproverId?: number | null;
  },
): Promise<number | null> {
  const settings = await getSettings(db);
  const customer = await db
    .select({ creditLimit: schema.customers.creditLimit })
    .from(schema.customers)
    .where(eq(schema.customers.id, input.customerId))
    .get();
  const limit = customer?.creditLimit ?? settings.defaultCreditLimit ?? null;
  let allowance: number | undefined;
  if (limit != null && limit > 0) {
    const outstanding = await getOutstandingCredit(db, input.customerId);
    allowance = Math.max(0, limit - outstanding);
  }
  return checkApproval(db, {
    kind: "credit",
    amount: input.creditAmount,
    userId: input.userId,
    actingPermissions: input.actingPermissions,
    verifiedApproverId: input.verifiedApproverId,
    thresholdOverride: allowance,
  });
}

// Le responsable refuse une demande d'approbation : trace dans le journal (compte
// dans les signaux du tableau de bord Contrôles pour l'employé qui l'a demandée).
export async function recordApprovalRejected(
  db: Database,
  input: { userId?: number | null; approverId?: number | null; kind: ApprovalKind; amount: number },
): Promise<void> {
  await logAction(db, {
    userId: input.userId ?? null,
    action: "approval_rejected",
    entity: "approval",
    entityId: input.approverId ?? null,
    metadata: { kind: input.kind, amount: input.amount },
  });
}

export interface DiscountLine {
  quantity: number;
  unitPrice: number;
  discount?: number;
  // Prix du catalogue (surcharge de variante ou prix produit).
  catalogPrice: number;
  // Meilleure promotion produit en cours pour cette ligne (%), 0 sinon.
  promoPercent: number;
}

// Part de remise NON couverte par une promotion programmée : baisse de prix sous
// le catalogue + remise de ligne + remise facture, moins ce que les promotions
// en cours autorisent. C'est ce montant qui exige l'approbation du propriétaire.
// La remise obtenue en échangeant des points de fidélité est un programme
// (pas une remise manuelle) : elle n'entre pas ici.
export function computeUnauthorizedDiscount(input: {
  lines: DiscountLine[];
  invoiceDiscount: number;
  invoicePromoPercent: number;
}): number {
  let unauthorized = 0;
  let itemsTotal = 0;
  for (const line of input.lines) {
    const priceCut = Math.max(0, line.quantity * (line.catalogPrice - line.unitPrice));
    const cut = priceCut + (line.discount ?? 0);
    const allowed = (line.quantity * line.catalogPrice * line.promoPercent) / 100;
    unauthorized += Math.max(0, cut - allowed);
    itemsTotal += line.quantity * line.unitPrice - (line.discount ?? 0);
  }
  const invoiceAllowed = (Math.max(0, itemsTotal) * input.invoicePromoPercent) / 100;
  unauthorized += Math.max(0, input.invoiceDiscount - invoiceAllowed);
  const rounded = roundMoney(unauthorized);
  // Tolérance d'arrondi des pourcentages calculés côté écran.
  return rounded <= 0.01 ? 0 : rounded;
}
