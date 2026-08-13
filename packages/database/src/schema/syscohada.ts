import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Comptes de charge SYSCOHADA par catégorie de dépense — la catégorie reste
// un champ texte libre (voir expenses.ts), donc cette table ne contraint
// jamais la saisie d'une dépense : elle sert uniquement à orienter l'export
// comptable (SyscohadaService.resolveExpenseAccount), avec repli sur
// businessSettings.syscohadaDefaultExpenseAccount* si la catégorie n'y
// figure pas encore.
export const syscohadaExpenseAccounts = sqliteTable("syscohada_expense_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull().unique(),
  accountCode: text("account_code").notNull(),
  accountLabel: text("account_label").notNull(),
});
