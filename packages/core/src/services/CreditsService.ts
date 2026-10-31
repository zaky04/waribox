import { roundMoney } from "../domain/money";
import type { Database } from "@gestion-boutique/database";
import { schema, withTransaction } from "@gestion-boutique/database";
import { formatAmount, t } from "@gestion-boutique/i18n";
import { desc, eq } from "drizzle-orm";
import { logAction } from "./AuditService";
import { requireAnyPermission, type PermissionSet } from "../domain/permissions";
import { assertValidAmount } from "../domain/validation";

export async function listCustomerCredits(db: Database, storeId?: number) {
  const query = db.select().from(schema.customerCredits).orderBy(desc(schema.customerCredits.id));
  return storeId ? query.where(eq(schema.customerCredits.storeId, storeId)) : query;
}

// Prédicat partagé "en retard" (créance non soldée dont l'échéance est
// dépassée) — utilisé à la fois par le Dashboard (compteur) et CreditsPage
// (bouton de relance WhatsApp), pour éviter que les deux dérivent avec des
// définitions légèrement différentes.
export function isCreditOverdue(
  credit: { status: string; dueDate: string | null },
  today: string = new Date().toISOString().slice(0, 10),
): boolean {
  return credit.status !== "settled" && !!credit.dueDate && credit.dueDate < today;
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

// Accessible depuis Créances (manage_credits) ET depuis le suivi des tickets
// de service (manage_service_orders, pour régler une créance née d'un ticket
// partiellement payé) — une seule des deux permissions suffit, voir
// requireAnyPermission.
export async function recordCreditRepayment(
  db: Database,
  input: RecordCreditRepaymentInput,
  actingPermissions: PermissionSet,
) {
  requireAnyPermission(actingPermissions, ["manage_credits", "manage_service_orders"]);
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error(t("coreErrors.credits.amountPositive"));
  }
  assertValidAmount(input.amount);

  // Lecture du solde, contrôle et écritures dans UNE transaction : sinon deux
  // règlements simultanés lisaient le même solde, passaient tous deux le contrôle
  // « ne dépasse pas le solde », et encaissaient plus que la créance ; une
  // erreur au milieu laissait aussi un règlement sans mise à jour de la créance.
  return withTransaction(async () => {
    const credit = await db
      .select()
      .from(schema.customerCredits)
      .where(eq(schema.customerCredits.id, input.creditId))
      .get();

    if (!credit) {
      throw new Error(t("coreErrors.credits.notFound"));
    }
    if (input.amount > credit.remainingBalance + 0.005) {
      throw new Error(t("coreErrors.common.amountExceedsBalance", { balance: formatAmount(credit.remainingBalance) }));
    }

    await db.insert(schema.creditRepayments).values({
      creditId: input.creditId,
      amount: input.amount,
      method: input.method,
      // Qui a encaissé, et où : permet de rapprocher le règlement du tiroir-caisse.
      receivedBy: input.userId,
      storeId: credit.storeId,
    });

    const remainingBalance = Math.max(0, roundMoney(credit.remainingBalance - input.amount));
    const status = remainingBalance <= 0 ? "settled" : "partial";

    const updated = await db
      .update(schema.customerCredits)
      .set({ remainingBalance, status })
      .where(eq(schema.customerCredits.id, input.creditId))
      .returning()
      .get();

    // La vente (ou le ticket de service) d'origine était « partielle »/« à crédit » :
    // une fois la créance soldée elle est payée. Sans ça elle restait « impayée »
    // dans l'historique et les filtres de Journaux/Historique des ventes.
    if (status === "settled") {
      if (credit.saleId != null) {
        await db.update(schema.sales).set({ paymentStatus: "paid" }).where(eq(schema.sales.id, credit.saleId)).run();
      }
      if (credit.serviceOrderId != null) {
        await db.update(schema.serviceOrders).set({ paymentStatus: "paid" }).where(eq(schema.serviceOrders.id, credit.serviceOrderId)).run();
      }
    }

    await logAction(db, {
      userId: input.userId,
      action: "record_credit_repayment",
      entity: "customer_credit",
      entityId: credit.id,
      metadata: { amount: input.amount, remainingBalance },
    });

    return updated;
  });
}
