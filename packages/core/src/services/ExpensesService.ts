import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { and, desc, eq, gte, like, lte, or } from "drizzle-orm";
import { logAction } from "./AuditService";

// Suggestions pour un datalist en UI — la catégorie reste un champ texte
// libre (pas de table de référence rigide) pour ne pas bloquer un gérant sur
// un cas non prévu, mais ces suggestions maintiennent une cohérence de
// nommage dans la durée (des années de saisie par plusieurs utilisateurs).
export const EXPENSE_CATEGORIES = [
  "Loyer",
  "Salaires",
  "Électricité",
  "Eau",
  "Transport",
  "Fournitures",
  "Entretien",
  "Assurance",
  "Impôts/Taxes",
  "Autre",
] as const;

export interface CreateExpenseInput {
  category: string;
  amount: number;
  expenseDate: string;
  note?: string;
  paymentMethod?: string;
  userId?: number;
}

// Insère aussi une ligne dans `payments` (referenceType: "expense") pour que
// getCashFlow n'ait pas besoin d'un chemin de calcul dédié aux dépenses — il
// lui suffit d'ajouter une branche à sa boucle existante sur `payments`. Le
// createdAt de cette ligne miroir est forcé à la date d'effet de la dépense
// (et non l'horodatage de saisie), pour que la dépense se rattache au bon
// mois dans la trésorerie même si elle est saisie en retard.
export async function createExpense(db: Database, input: CreateExpenseInput) {
  const expense = await db
    .insert(schema.expenses)
    .values({
      category: input.category,
      amount: input.amount,
      expenseDate: input.expenseDate,
      note: input.note,
      paymentMethod: input.paymentMethod,
      userId: input.userId,
    })
    .returning()
    .get();

  await db.insert(schema.payments).values({
    referenceType: "expense",
    referenceId: expense.id,
    method: input.paymentMethod ?? "cash",
    amount: input.amount,
    receivedBy: input.userId,
    createdAt: `${input.expenseDate} 12:00:00`,
  });

  await logAction(db, {
    userId: input.userId ?? null,
    action: "create_expense",
    entity: "expense",
    entityId: expense.id,
    metadata: { category: expense.category, amount: expense.amount, expenseDate: expense.expenseDate },
  });

  return expense;
}

export interface UpdateExpenseInput {
  category?: string;
  amount?: number;
  expenseDate?: string;
  note?: string;
  paymentMethod?: string;
  userId?: number; // qui effectue la modification (pour l'audit, pas forcément le créateur)
}

export async function updateExpense(db: Database, id: number, input: UpdateExpenseInput) {
  const expense = await db
    .update(schema.expenses)
    .set({
      category: input.category,
      amount: input.amount,
      expenseDate: input.expenseDate,
      note: input.note,
      paymentMethod: input.paymentMethod,
    })
    .where(eq(schema.expenses.id, id))
    .returning()
    .get();

  // Garde la ligne payments miroir synchronisée, sinon la trésorerie
  // resterait incohérente avec la dépense corrigée.
  const mirrorPayment = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.referenceType, "expense"), eq(schema.payments.referenceId, id)))
    .get();
  if (mirrorPayment) {
    await db
      .update(schema.payments)
      .set({
        amount: expense.amount,
        method: expense.paymentMethod ?? "cash",
        createdAt: `${expense.expenseDate} 12:00:00`,
      })
      .where(eq(schema.payments.id, mirrorPayment.id));
  }

  await logAction(db, {
    userId: input.userId ?? null,
    action: "update_expense",
    entity: "expense",
    entityId: expense.id,
    metadata: { category: expense.category, amount: expense.amount },
  });

  return expense;
}

// Seule suppression physique du codebase (les autres domaines utilisent un
// statut, ex: customerCredits.status/users.isActive) — sûre ici car aucune
// autre table ne référence expenses.id. La traçabilité reste assurée par le
// journal (métadonnées de l'enregistrement supprimé), important pour un usage
// sur plusieurs années.
export async function deleteExpense(db: Database, id: number, userId?: number) {
  const existing = await db.select().from(schema.expenses).where(eq(schema.expenses.id, id)).get();
  if (!existing) return;

  await db
    .delete(schema.payments)
    .where(and(eq(schema.payments.referenceType, "expense"), eq(schema.payments.referenceId, id)));
  await db.delete(schema.expenses).where(eq(schema.expenses.id, id));

  await logAction(db, {
    userId: userId ?? null,
    action: "delete_expense",
    entity: "expense",
    entityId: id,
    metadata: { category: existing.category, amount: existing.amount, expenseDate: existing.expenseDate },
  });
}

export interface ExpenseFilters {
  from?: string; // "YYYY-MM-DD", comparé à expenseDate (date pure)
  to?: string;
  category?: string;
  userId?: number;
  search?: string; // LIKE sur category + note
}

export async function listExpenses(db: Database, filters: ExpenseFilters = {}) {
  const conditions = [];
  if (filters.from) conditions.push(gte(schema.expenses.expenseDate, filters.from.slice(0, 10)));
  if (filters.to) conditions.push(lte(schema.expenses.expenseDate, filters.to.slice(0, 10)));
  if (filters.category) conditions.push(eq(schema.expenses.category, filters.category));
  if (filters.userId) conditions.push(eq(schema.expenses.userId, filters.userId));
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    conditions.push(or(like(schema.expenses.category, pattern), like(schema.expenses.note, pattern)));
  }

  const query = db
    .select()
    .from(schema.expenses)
    .orderBy(desc(schema.expenses.expenseDate), desc(schema.expenses.id));
  return conditions.length > 0 ? query.where(and(...conditions)) : query;
}
