import {
  adjustPoints,
  computeTier,
  createCustomer,
  getSettings,
  hasPermission,
  listCustomerCredits,
  listCustomers,
  getTierLabel,
  updateCustomer,
  type LoyaltyTier,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
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

type Customer = typeof schema.customers.$inferSelect;
type Credit = typeof schema.customerCredits.$inferSelect;

export function CustomersPage() {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [credits, setCredits] = useState<Credit[]>([]);
  const [tierThresholds, setTierThresholds] = useState({ silver: 5000, gold: 20000 });

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [adjustingId, setAdjustingId] = useState<number | null>(null);
  const [pointsDelta, setPointsDelta] = useState("");
  const [pointsReason, setPointsReason] = useState("");
  const [pointsError, setPointsError] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);

  const refresh = useCallback(async () => {
    const [customerRows, creditRows] = await Promise.all([
      listCustomers(db),
      listCustomerCredits(db),
    ]);
    setCustomers(customerRows);
    setCredits(creditRows);
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Seuils lus une seule fois (pas par client) — le palier lui-même est
  // calculé côté client via computeTier, pas stocké en base.
  useEffect(() => {
    (async () => {
      const settings = await getSettings(db);
      setTierThresholds({ silver: settings.loyaltyTierSilverThreshold, gold: settings.loyaltyTierGoldThreshold });
    })();
  }, [db]);

  const tierBadgeStyle = (tier: LoyaltyTier): CSSProperties => {
    const colors: Record<LoyaltyTier, { bg: string; fg: string }> = {
      bronze: { bg: "rgba(205, 127, 50, 0.18)", fg: "#cd7f32" },
      silver: { bg: "rgba(148, 163, 184, 0.2)", fg: "#94a3b8" },
      gold: { bg: "rgba(234, 179, 8, 0.18)", fg: "#eab308" },
    };
    return {
      display: "inline-block",
      padding: "2px 10px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 700,
      background: colors[tier].bg,
      color: colors[tier].fg,
    };
  };

  const creditBalance = (customerId: number) =>
    credits
      .filter((c) => c.customerId === customerId && c.status !== "settled")
      .reduce((sum, c) => sum + c.remainingBalance, 0);

  const resetForm = () => {
    setEditingId(null);
    setFullName("");
    setPhone("");
    setEmail("");
    setAddress("");
    setShowForm(false);
  };

  const startEdit = (customer: Customer) => {
    setEditingId(customer.id);
    setFullName(customer.fullName);
    setPhone(customer.phone ?? "");
    setEmail(customer.email ?? "");
    setAddress(customer.address ?? "");
    setShowForm(true);
  };

  const handleSubmit = async () => {
    setError(null);
    if (!fullName.trim()) {
      setError(t("customers.errors.nameRequired"));
      return;
    }

    setSaving(true);
    try {
      const input = {
        fullName: fullName.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        address: address.trim() || undefined,
        createdBy: user?.id,
      };
      if (editingId) {
        await updateCustomer(db, editingId, input, user?.permissions ?? {});
      } else {
        await createCustomer(db, input, user?.permissions ?? {});
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

  const startAdjust = (customer: Customer) => {
    setAdjustingId(customer.id);
    setPointsDelta("");
    setPointsReason("");
    setPointsError(null);
  };

  const handleAdjustSubmit = async (customer: Customer) => {
    setPointsError(null);
    if (!user) return;
    const delta = Number(pointsDelta);
    if (!delta) {
      setPointsError(t("customers.errors.deltaRequired"));
      return;
    }

    setAdjusting(true);
    try {
      await adjustPoints(db, {
        customerId: customer.id,
        pointsDelta: delta,
        userId: user.id,
        reason: pointsReason.trim() || undefined,
      });
      setAdjustingId(null);
      await refresh();
    } catch (err) {
      setPointsError(err instanceof Error ? err.message : t("customers.errors.adjustFailed"));
    } finally {
      setAdjusting(false);
    }
  };

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1>{t("customers.title")}</h1>
        <button
          style={primaryButtonStyle}
          onClick={() => (showForm ? resetForm() : setShowForm(true))}
        >
          {showForm ? t("customers.cancel") : t("customers.new")}
        </button>
      </div>

      {showForm && (
        <div style={cardStyle}>
          <label>
            {t("customers.fullName")}
            <input style={inputStyle} value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </label>
          <label>
            {t("customers.phone")}
            <input style={inputStyle} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label>
            {t("customers.email")}
            <input
              style={inputStyle}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            {t("customers.address")}
            <input style={inputStyle} value={address} onChange={(e) => setAddress(e.target.value)} />
          </label>

          {error && <p style={{ color: "#f87171" }}>{error}</p>}

          <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
            {saving ? t("customers.saving") : editingId ? t("customers.saveChanges") : t("customers.create")}
          </button>
        </div>
      )}

      <div className="table-scroll">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>{t("customers.fullName")}</th>
              <th style={thStyle}>{t("customers.phone")}</th>
              <th style={thStyle}>{t("customers.email")}</th>
              <th style={thStyle}>{t("customers.creditBalance")}</th>
              <th style={thStyle}>{t("customers.loyaltyPoints")}</th>
              <th style={thStyle}>{t("customers.tier")}</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <td style={tdStyle}>{c.fullName}</td>
                <td style={tdStyle}>{c.phone ?? "—"}</td>
                <td style={tdStyle}>{c.email ?? "—"}</td>
                <td style={{ ...tdStyle, color: creditBalance(c.id) > 0 ? "#fdba74" : undefined }}>
                  {creditBalance(c.id) > 0 ? creditBalance(c.id) : "—"}
                </td>
                <td style={tdStyle}>{c.loyaltyPoints}</td>
                <td style={tdStyle}>
                  {(() => {
                    const tier = computeTier(c.lifetimeLoyaltyPoints, tierThresholds.silver, tierThresholds.gold);
                    return <span style={tierBadgeStyle(tier)}>{getTierLabel(tier)}</span>;
                  })()}
                </td>
                <td style={tdStyle}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {user && hasPermission(user.permissions, "edit_customers") && (
                      <button
                        style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                        onClick={() => startEdit(c)}
                      >
                        {t("customers.edit")}
                      </button>
                    )}
                    <button
                      style={{
                        ...primaryButtonStyle,
                        padding: "6px 12px",
                        fontSize: 14,
                        background: "transparent",
                        border: "1px solid var(--color-border)",
                        color: "var(--color-text)",
                      }}
                      onClick={() => startAdjust(c)}
                    >
                      {t("customers.adjustPoints")}
                    </button>
                  </div>
                  {adjustingId === c.id && (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                      <input
                        type="number"
                        placeholder={t("customers.pointsDeltaPlaceholder")}
                        style={{ ...inputStyle, width: 100, marginTop: 0 }}
                        value={pointsDelta}
                        onChange={(e) => setPointsDelta(e.target.value)}
                      />
                      <input
                        placeholder={t("customers.pointsReasonPlaceholder")}
                        style={{ ...inputStyle, width: 140, marginTop: 0 }}
                        value={pointsReason}
                        onChange={(e) => setPointsReason(e.target.value)}
                      />
                      <button
                        style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                        onClick={() => handleAdjustSubmit(c)}
                        disabled={adjusting}
                      >
                        {t("customers.confirm")}
                      </button>
                      <button
                        style={{ background: "transparent", border: "none", color: "var(--color-text-muted)", cursor: "pointer" }}
                        onClick={() => setAdjustingId(null)}
                      >
                        {t("customers.cancelAdjust")}
                      </button>
                    </div>
                  )}
                  {adjustingId === c.id && pointsError && (
                    <p style={{ color: "#f87171", fontSize: 13 }}>{pointsError}</p>
                  )}
                </td>
              </tr>
            ))}
            {customers.length === 0 && (
              <tr>
                <td style={tdStyle} colSpan={7}>
                  {t("customers.none")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
