import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { desc, eq } from "drizzle-orm";
import { logAction } from "./AuditService";
import { requirePermission, type PermissionSet } from "../domain/permissions";

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
}

export async function recordDebtPayment(
  db: Database,
  input: RecordDebtPaymentInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_debts");
  const debt = await db
    .select()
    .from(schema.supplierDebts)
    .where(eq(schema.supplierDebts.id, input.debtId))
    .get();

  if (!debt) {
    throw new Error(t("coreErrors.debts.notFound"));
  }
  if (input.amount <= 0) {
    throw new Error(t("coreErrors.debts.amountPositive"));
  }
  if (input.amount > debt.remainingBalance) {
    throw new Error(t("coreErrors.common.amountExceedsBalance", { balance: debt.remainingBalance }));
  }

  await db.insert(schema.supplierDebtPayments).values({
    debtId: input.debtId,
    amount: input.amount,
  });

  const remainingBalance = debt.remainingBalance - input.amount;
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
    metadata: { amount: input.amount, remainingBalance },
  });

  return updated;
}
