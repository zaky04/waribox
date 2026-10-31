import { roundMoney } from "../domain/money";
import type { Database } from "@gestion-boutique/database";
import { schema, withTransaction } from "@gestion-boutique/database";
import { formatAmount, t } from "@gestion-boutique/i18n";
import { desc, eq } from "drizzle-orm";
import { logAction } from "./AuditService";
import { requireApproval, type ApprovalInput } from "./ApprovalService";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { assertValidAmount } from "../domain/validation";

export async function listSupplierDebts(db: Database, storeId?: number) {
  const query = db.select().from(schema.supplierDebts).orderBy(desc(schema.supplierDebts.id));
  return storeId ? query.where(eq(schema.supplierDebts.storeId, storeId)) : query;
}

export async function listDebtPayments(db: Database, debtId: number) {
  return db
    .select()
    .from(schema.supplierDebtPayments)
    .where(eq(schema.supplierDebtPayments.debtId, debtId))
    .orderBy(desc(schema.supplierDebtPayments.id));
}

export interface RecordDebtPaymentInput {
  debtId: number;
  amount: number;
  userId: number;
  approval?: ApprovalInput;
}

export async function recordDebtPayment(
  db: Database,
  input: RecordDebtPaymentInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_debts");
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error(t("coreErrors.debts.amountPositive"));
  }
  assertValidAmount(input.amount);
  // Un paiement fournisseur est une sortie d'argent : seuil d'approbation dédié.
  const approvedBy = await requireApproval(db, { kind: "payment", amount: input.amount, userId: input.userId, actingPermissions, approval: input.approval });

  // Même raison que recordCreditRepayment : lecture du solde et écritures dans
  // une seule transaction, sinon deux paiements simultanés dépassent la dette.
  return withTransaction(async () => {
    const debt = await db
      .select()
      .from(schema.supplierDebts)
      .where(eq(schema.supplierDebts.id, input.debtId))
      .get();

    if (!debt) {
      throw new Error(t("coreErrors.debts.notFound"));
    }
    if (input.amount > debt.remainingBalance + 0.005) {
      throw new Error(t("coreErrors.common.amountExceedsBalance", { balance: formatAmount(debt.remainingBalance) }));
    }

    await db.insert(schema.supplierDebtPayments).values({
      debtId: input.debtId,
      amount: input.amount,
      paidBy: input.userId,
    });

    const remainingBalance = Math.max(0, roundMoney(debt.remainingBalance - input.amount));
    const status = remainingBalance <= 0 ? "settled" : "partial";

    const updated = await db
      .update(schema.supplierDebts)
      .set({ remainingBalance, status })
      .where(eq(schema.supplierDebts.id, input.debtId))
      .returning()
      .get();

    await logAction(db, {
      userId: input.userId,
      action: "record_debt_payment",
      entity: "supplier_debt",
      entityId: debt.id,
      metadata: { amount: input.amount, remainingBalance, approvedBy },
    });

    return updated;
  });
}
