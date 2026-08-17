import {
  createExpense,
  deleteExpense,
  EXPENSE_CATEGORIES,
  hasPermission,
  listExpenses,
  listUsers,
  updateExpense,
  type ExpenseFilters,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { FilterBar } from "../../components/FilterBar";
import {
  cardStyle,
  inputStyle,
  pageStyle,
  primaryButtonStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "../../components/sharedStyles";
import { useAuth } from "../auth/useAuth";

type Expense = typeof schema.expenses.$inferSelect;
type User = { id: number; fullName: string };

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function ExpensesPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const { t } = useTranslation();
  const canManage = user ? hasPermission(user.permissions, "manage_expenses") : false;
  const canEdit = user ? hasPermission(user.permissions, "edit_expenses") : false;

  const PAYMENT_METHODS: { value: string; label: string }[] = [
    { value: "cash", label: t("expenses.paymentMethods.cash") },
    { value: "card", label: t("expenses.paymentMethods.card") },
    { value: "mobile_money", label: t("expenses.paymentMethods.mobile_money") },
    { value: "bank_transfer", label: t("expenses.paymentMethods.bank_transfer") },
    { value: "other", label: t("expenses.paymentMethods.other") },
  ];

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterSearch, setFilterSearch] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState(isoDate(new Date()));
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const filters: ExpenseFilters = {
      from: filterFrom || undefined,
      to: filterTo || undefined,
      category: filterCategory || undefined,
      search: filterSearch || undefined,
      storeId: currentStoreId ?? undefined,
    };
    const [expenseRows, userRows] = await Promise.all([listExpenses(db, filters), listUsers(db)]);
    setExpenses(expenseRows);
    setUsers(userRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, filterFrom, filterTo, filterCategory, filterSearch, currentStoreId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const userName = (id: number | null) => users.find((u) => u.id === id)?.fullName ?? "—";

  const resetForm = () => {
    setEditingId(null);
    setCategory("");
    setAmount("");
    setExpenseDate(isoDate(new Date()));
    setPaymentMethod("cash");
    setNote("");
    setShowForm(false);
  };

  const startEdit = (expense: Expense) => {
    setEditingId(expense.id);
    setCategory(expense.category);
    setAmount(String(expense.amount));
    setExpenseDate(expense.expenseDate);
    setPaymentMethod(expense.paymentMethod ?? "cash");
    setNote(expense.note ?? "");
    setShowForm(true);
  };

  const handleSubmit = async () => {
    setError(null);
    if (!category.trim()) {
      setError(t("expenses.errors.categoryRequired"));
      return;
    }
    const value = Number(amount);
    if (!value || value <= 0) {
      setError(t("expenses.errors.amountPositive"));
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        await updateExpense(db, editingId, {
          category: category.trim(),
          amount: value,
          expenseDate,
          paymentMethod,
          note: note.trim() || undefined,
          userId: user?.id,
        }, user?.permissions ?? {});
      } else {
        await createExpense(db, {
          category: category.trim(),
          amount: value,
          expenseDate,
          paymentMethod,
          note: note.trim() || undefined,
          userId: user?.id,
          storeId: currentStoreId ?? undefined,
        }, user?.permissions ?? {});
      }
      resetForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("expenses.errors.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (expense: Expense) => {
    if (!window.confirm(t("expenses.confirmDelete", { category: expense.category, amount: expense.amount }))) {
      return;
    }
    await deleteExpense(db, expense.id, user?.permissions ?? {}, user?.id);
    await refresh();
  };

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1>{t("expenses.title")}</h1>
        {canManage && (
          <button style={primaryButtonStyle} onClick={() => (showForm ? resetForm() : setShowForm(true))}>
            {showForm ? t("expenses.cancel") : t("expenses.new")}
          </button>
        )}
      </div>

      {showForm && (
        <div style={cardStyle}>
          <label>
            {t("expenses.category")}
            <input
              style={inputStyle}
              list="expense-categories"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder={t("expenses.categoryPlaceholder")}
            />
            <datalist id="expense-categories">
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label>
            {t("expenses.amount")}
            <input
              style={inputStyle}
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label>
            {t("expenses.expenseDate")}
            <input
              style={inputStyle}
              type="date"
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
            />
          </label>
          <label>
            {t("expenses.paymentMethod")}
            <select style={inputStyle} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("expenses.note")}
            <input style={inputStyle} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>

          {error && <p style={{ color: "#f87171" }}>{error}</p>}

          <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
            {saving ? t("expenses.saving") : editingId ? t("expenses.saveChanges") : t("expenses.create")}
          </button>
        </div>
      )}

      <FilterBar
        from={filterFrom}
        onFromChange={setFilterFrom}
        to={filterTo}
        onToChange={setFilterTo}
        search={filterSearch}
        onSearchChange={setFilterSearch}
        searchPlaceholder={t("expenses.searchPlaceholder")}
        onReset={() => {
          setFilterFrom("");
          setFilterTo("");
          setFilterCategory("");
          setFilterSearch("");
        }}
      >
        <label>
          {t("expenses.category")}
          <select style={inputStyle} value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
            <option value="">{t("expenses.all")}</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      <div className="table-scroll">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>{t("expenses.date")}</th>
              <th style={thStyle}>{t("expenses.category")}</th>
              <th style={thStyle}>{t("expenses.amount")}</th>
              <th style={thStyle}>{t("expenses.note")}</th>
              <th style={thStyle}>{t("expenses.user")}</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((expense) => (
              <tr key={expense.id}>
                <td style={tdStyle}>{expense.expenseDate}</td>
                <td style={tdStyle}>{expense.category}</td>
                <td style={tdStyle}>{expense.amount.toFixed(0)}</td>
                <td style={tdStyle}>{expense.note ?? "—"}</td>
                <td style={tdStyle}>{userName(expense.userId)}</td>
                <td style={tdStyle}>
                  {canEdit && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <button
                        style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                        onClick={() => startEdit(expense)}
                      >
                        {t("expenses.edit")}
                      </button>
                      <button
                        style={{
                          background: "transparent",
                          border: "1px solid #f87171",
                          color: "#f87171",
                          borderRadius: 8,
                          padding: "6px 12px",
                          fontSize: 14,
                          cursor: "pointer",
                        }}
                        onClick={() => handleDelete(expense)}
                      >
                        {t("expenses.delete")}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {expenses.length === 0 && (
              <tr>
                <td style={tdStyle} colSpan={6}>
                  {t("expenses.none")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
