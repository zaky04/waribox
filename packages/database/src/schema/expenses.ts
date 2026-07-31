import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./users";

// Dépenses/charges non liées à un achat de marchandise (loyer, salaires,
// électricité...) — nécessaires pour que le compte de résultat simplifié
// reflète les charges réelles de l'entreprise, pas seulement le coût des
// marchandises vendues (voir AccountingService.getIncomeStatement). Chaque
// dépense a aussi une ligne miroir dans `payments` (referenceType: "expense")
// pour que getCashFlow n'ait pas besoin d'un chemin de calcul séparé — voir
// ExpensesService.
export const expenses = sqliteTable("expenses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull(), // texte libre ; suggestions via EXPENSE_CATEGORIES (datalist UI)
  amount: real("amount").notNull(),
  // Date à laquelle la dépense s'applique (ex: loyer de juillet payé le 3
  // août) — distincte de createdAt (horodatage de saisie). Toujours une date
  // pure "YYYY-MM-DD" (10 caractères).
  expenseDate: text("expense_date").notNull(),
  note: text("note"),
  paymentMethod: text("payment_method"), // 'cash' | 'card' | 'mobile_money' | 'bank_transfer' | 'other' | null
  userId: integer("user_id").references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
