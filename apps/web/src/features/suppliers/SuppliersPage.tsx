import {
  createSupplier,
  hasPermission,
  listSupplierDebts,
  listSuppliers,
  updateSupplier,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
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

type Supplier = typeof schema.suppliers.$inferSelect;
type Debt = typeof schema.supplierDebts.$inferSelect;

export function SuppliersPage() {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [debts, setDebts] = useState<Debt[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [supplierRows, debtRows] = await Promise.all([
      listSuppliers(db),
      listSupplierDebts(db),
    ]);
    setSuppliers(supplierRows);
    setDebts(debtRows);
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const debtBalance = (supplierId: number) =>
    debts
      .filter((d) => d.supplierId === supplierId && d.status !== "settled")
      .reduce((sum, d) => sum + d.remainingBalance, 0);

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setPhone("");
    setContactPerson("");
    setShowForm(false);
  };

  const startEdit = (supplier: Supplier) => {
    setEditingId(supplier.id);
    setName(supplier.name);
    setPhone(supplier.phone ?? "");
    setContactPerson(supplier.contactPerson ?? "");
    setShowForm(true);
  };

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) {
      setError(t("suppliers.errors.nameRequired"));
      return;
    }

    setSaving(true);
    try {
      const input = {
        name: name.trim(),
        phone: phone.trim() || undefined,
        contactPerson: contactPerson.trim() || undefined,
        createdBy: user?.id,
      };
      if (editingId) {
        await updateSupplier(db, editingId, input, user?.permissions ?? {});
      } else {
        await createSupplier(db, input, user?.permissions ?? {});
      }
      resetForm();
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>{t("suppliers.title")}</h1>
        <button
          style={primaryButtonStyle}
          onClick={() => (showForm ? resetForm() : setShowForm(true))}
        >
          {showForm ? t("suppliers.cancel") : t("suppliers.new")}
        </button>
      </div>

      {showForm && (
        <div style={cardStyle}>
          <label>
            {t("suppliers.name")}
            <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            {t("suppliers.phone")}
            <input style={inputStyle} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label>
            {t("suppliers.contactPerson")}
            <input
              style={inputStyle}
              value={contactPerson}
              onChange={(e) => setContactPerson(e.target.value)}
            />
          </label>

          {error && <p style={{ color: "#f87171" }}>{error}</p>}

          <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
            {saving ? t("suppliers.saving") : editingId ? t("suppliers.saveChanges") : t("suppliers.create")}
          </button>
        </div>
      )}

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>{t("suppliers.name")}</th>
            <th style={thStyle}>{t("suppliers.phone")}</th>
            <th style={thStyle}>{t("suppliers.contactPerson")}</th>
            <th style={thStyle}>{t("suppliers.debtBalance")}</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {suppliers.map((s) => (
            <tr key={s.id}>
              <td style={tdStyle}>{s.name}</td>
              <td style={tdStyle}>{s.phone ?? "—"}</td>
              <td style={tdStyle}>{s.contactPerson ?? "—"}</td>
              <td style={{ ...tdStyle, color: debtBalance(s.id) > 0 ? "#fdba74" : undefined }}>
                {debtBalance(s.id) > 0 ? debtBalance(s.id) : "—"}
              </td>
              <td style={tdStyle}>
                {user && hasPermission(user.permissions, "edit_suppliers") && (
                  <button
                    style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                    onClick={() => startEdit(s)}
                  >
                    {t("suppliers.edit")}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {suppliers.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={5}>
                {t("suppliers.none")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
