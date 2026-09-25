import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { formatAmount, t } from "@gestion-boutique/i18n";
import { eq } from "drizzle-orm";
import { verifyPin } from "../auth/AuthService";
import { applyOverrides, hasPermission, parseOverrides, type PermissionSet } from "../domain/permissions";
import { logAction } from "./AuditService";
import { getSettings } from "./SettingsService";

// Approbation d'un responsable pour les actions sensibles (remboursement, perte
// ou entrée manuelle de stock, vente à crédit) qui dépassent un plafond : le
// responsable saisit son code PIN sur l'appareil de l'employé. Les seuils
// viennent des paramètres (globaux) ou du plafond personnel de l'utilisateur.
// NULL = pas de contrôle ; 0 = toute action de ce type exige une approbation.
export type ApprovalKind = "refund" | "stock" | "credit";

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
      t("coreErrors.approval.required", {
        kind: t(`approval.kinds.${kind}`),
        amount: formatAmount(amount),
        threshold: formatAmount(threshold),
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
  return hasPermission(perms, "approve_actions") ? { id: row.id } : undefined;
}

// Utilisateurs actifs pouvant approuver (et ayant un code PIN) — pour la fenêtre
// de saisie de l'approbation.
export async function listApprovers(db: Database): Promise<{ id: number; fullName: string }[]> {
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
    .filter((r) => r.isActive && r.pinHash && hasPermission(applyOverrides(JSON.parse(r.permissions) as PermissionSet, parseOverrides(r.overrides)), "approve_actions"))
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
  if (hasPermission(input.actingPermissions, "approve_actions")) return null;

  const settings = await getSettings(db);
  const globalThreshold =
    input.kind === "refund"
      ? settings.approvalRefundThreshold
      : input.kind === "stock"
        ? settings.approvalStockThreshold
        : settings.approvalCreditThreshold;

  let userLimit: number | null = null;
  if (input.userId != null) {
    const user = await db
      .select({ limitRefund: schema.users.limitRefund, limitStock: schema.users.limitStock, limitCredit: schema.users.limitCredit })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .get();
    userLimit = input.kind === "refund" ? (user?.limitRefund ?? null) : input.kind === "stock" ? (user?.limitStock ?? null) : (user?.limitCredit ?? null);
  }

  let threshold = pickThreshold(userLimit, globalThreshold);
  if (input.thresholdOverride != null) {
    threshold = threshold == null ? input.thresholdOverride : Math.min(threshold, input.thresholdOverride);
  }
  if (!exceedsThreshold(input.amount, threshold)) return null;
  if (input.verifiedApproverId == null) throw new ApprovalRequiredError(input.kind, input.amount, threshold!);
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
  if (hasPermission(input.actingPermissions, "approve_actions")) return null;
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
