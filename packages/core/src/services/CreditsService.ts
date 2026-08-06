import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { desc, eq } from "drizzle-orm";
import { logAction } from "./AuditService";

export async function listCustomerCredits(db: Database, storeId?: number) {
  const query = db.select().from(schema.customerCredits).orderBy(desc(schema.customerCredits.id));
  return storeId ? query.where(eq(schema.customerCredits.storeId, storeId)) : query;
}

export async function listCreditRepayments(db: Database, creditId: number) {
  return db
    .select()
    .from(schema.creditRepayments)
    .where(eq(schema.creditRepayments.creditId, creditId))
    .orderBy(desc(schema.creditRepayments.id));
}

export interface RecordCreditRepaymentInput {
  creditId: number;
  amount: number;
  method?: string;
  userId: number;
}

export async function recordCreditRepayment(db: Database, input: RecordCreditRepaymentInput) {
  const credit = await db
    .select()
    .from(schema.customerCredits)
    .where(eq(schema.customerCredits.id, input.creditId))
    .get();

  if (!credit) {
    throw new Error("Créance introuvable.");
  }
  if (input.amount <= 0) {
    throw new Error("Le montant du remboursement doit être supérieur à zéro.");
  }
  if (input.amount > credit.remainingBalance) {
    throw new Error(
      `Le montant dépasse le solde restant (${credit.remainingBalance}).`,
    );
  }

  await db.insert(schema.creditRepayments).values({
    creditId: input.creditId,
    amount: input.amount,
    method: input.method,
  });

  const remainingBalance = credit.remainingBalance - input.amount;
  const status = remainingBalance <= 0 ? "settled" : "partial";

  const updated = await db
    .update(schema.customerCredits)
    .set({ remainingBalance, status })
    .where(eq(schema.customerCredits.id, input.creditId))
    .returning()
    .get();

  await logAction(db, {
    userId: input.userId,
    action: "record_credit_repayment",
    entity: "customer_credit",
    entityId: credit.id,
    metadata: { amount: input.amount, remainingBalance },
  });

  return updated;
}
