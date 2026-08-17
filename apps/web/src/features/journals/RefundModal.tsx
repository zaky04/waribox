import { createRefund, getRefundedQuantities, listSaleItems, type RefundMethod } from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { useAuth } from "../auth/useAuth";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";

type Sale = typeof schema.sales.$inferSelect;
type SaleItem = typeof schema.saleItems.$inferSelect;

interface RefundLineState {
  quantity: string;
  restock: boolean;
}

export function RefundModal({
  sale,
  variantLabel,
  onClose,
  onDone,
}: {
  sale: Sale;
  variantLabel: (variantId: number) => string;
  onClose: () => void;
  onDone: () => void;
}) {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();

  const METHOD_LABELS: Record<RefundMethod, string> = {
    cash: t("journals.refundMethods.cash"),
    card: t("journals.refundMethods.card"),
    mobile_money: t("journals.refundMethods.mobile_money"),
  };

  const [items, setItems] = useState<SaleItem[]>([]);
  const [refunded, setRefunded] = useState<Record<number, number>>({});
  const [lines, setLines] = useState<Record<number, RefundLineState>>({});
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState<RefundMethod>("cash");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [saleItems, refundedQty] = await Promise.all([listSaleItems(db, sale.id), getRefundedQuantities(db, sale.id)]);
      setItems(saleItems);
      setRefunded(refundedQty);
      const initialLines: Record<number, RefundLineState> = {};
      for (const item of saleItems) {
        initialLines[item.id] = { quantity: "", restock: true };
      }
      setLines(initialLines);
      setLoading(false);
    })();
  }, [db, sale.id]);

  const remaining = (item: SaleItem) => item.quantity - (refunded[item.id] ?? 0);

  const previewTotal = items.reduce((sum, item) => {
    const qty = Number(lines[item.id]?.quantity ?? 0);
    if (!qty || qty <= 0) return sum;
    return sum + (item.total * qty) / item.quantity;
  }, 0);

  const handleSubmit = async () => {
    if (!user) return;
    setError(null);

    const selected = items
      .map((item) => {
        const qty = Number(lines[item.id]?.quantity ?? 0);
        return { saleItemId: item.id, quantity: qty, restock: lines[item.id]?.restock ?? true };
      })
      .filter((line) => line.quantity > 0);

    if (selected.length === 0) {
      setError(t("journals.refundModal.errorQuantityRequired"));
      return;
    }

    setSaving(true);
    try {
      await createRefund(
        db,
        { saleId: sale.id, items: selected, reason: reason.trim() || undefined, method, userId: user.id },
        user.permissions,
      );
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("journals.refundModal.errorGeneric"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{ ...cardStyle, width: "min(560px, 100%)", maxHeight: "85vh", overflowY: "auto", marginTop: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: 0 }}>{t("journals.refundModal.title", { number: sale.number })}</h2>

        {loading ? (
          <p>{t("journals.refundModal.loading")}</p>
        ) : (
          <>
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: 6 }}>{t("journals.refundModal.item")}</th>
                  <th style={{ textAlign: "right", padding: 6 }}>{t("journals.refundModal.remaining")}</th>
                  <th style={{ textAlign: "right", padding: 6 }}>{t("journals.refundModal.quantityToRefund")}</th>
                  <th style={{ textAlign: "center", padding: 6 }}>{t("journals.refundModal.restock")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const max = remaining(item);
                  return (
                    <tr key={item.id}>
                      <td style={{ padding: 6 }}>{variantLabel(item.variantId)}</td>
                      <td style={{ padding: 6, textAlign: "right" }}>{max}</td>
                      <td style={{ padding: 6, textAlign: "right" }}>
                        <input
                          style={{ ...inputStyle, width: 80, textAlign: "right" }}
                          type="number"
                          min={0}
                          max={max}
                          disabled={max <= 0}
                          value={lines[item.id]?.quantity ?? ""}
                          onChange={(e) =>
                            setLines((prev) => ({
                              ...prev,
                              [item.id]: { quantity: e.target.value, restock: prev[item.id]?.restock ?? true },
                            }))
                          }
                        />
                      </td>
                      <td style={{ padding: 6, textAlign: "center" }}>
                        <input
                          type="checkbox"
                          disabled={max <= 0}
                          checked={lines[item.id]?.restock ?? true}
                          onChange={(e) =>
                            setLines((prev) => ({
                              ...prev,
                              [item.id]: { quantity: prev[item.id]?.quantity ?? "", restock: e.target.checked },
                            }))
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <label style={{ display: "block", marginTop: 12 }}>
              {t("journals.refundModal.reason")}
              <input style={inputStyle} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>

            <label style={{ display: "block", marginTop: 12 }}>
              {t("journals.refundModal.method")}
              <select style={inputStyle} value={method} onChange={(e) => setMethod(e.target.value as RefundMethod)}>
                {Object.entries(METHOD_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <p style={{ marginTop: 12, fontWeight: 600 }}>
              {t("journals.refundModal.totalToRefund")} {previewTotal.toFixed(2)}
            </p>

            {error && <p style={{ color: "#f87171" }}>{error}</p>}

            <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
              <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
                {saving ? t("journals.refundModal.saving") : t("journals.refundModal.submit")}
              </button>
              <button
                onClick={onClose}
                style={{
                  background: "transparent",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                  borderRadius: "var(--radius-md)",
                  padding: "12px 18px",
                  cursor: "pointer",
                }}
              >
                {t("journals.refundModal.cancel")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
