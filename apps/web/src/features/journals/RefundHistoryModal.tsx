import { listRefundItems, listRefundsForSale, listSaleItems, type RefundMethod } from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle } from "../../components/sharedStyles";

type Sale = typeof schema.sales.$inferSelect;
type Refund = typeof schema.refunds.$inferSelect;
type RefundItem = typeof schema.refundItems.$inferSelect;

export function RefundHistoryModal({
  sale,
  variantLabel,
  onClose,
}: {
  sale: Sale;
  variantLabel: (variantId: number) => string;
  onClose: () => void;
}) {
  const db = useDatabase();
  const { t } = useTranslation();
  const METHOD_LABELS: Record<RefundMethod, string> = {
    cash: t("journals.refundMethods.cash"),
    card: t("journals.refundMethods.card"),
    mobile_money: t("journals.refundMethods.mobile_money"),
  };
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [itemsByRefund, setItemsByRefund] = useState<Record<number, RefundItem[]>>({});
  const [variantBySaleItem, setVariantBySaleItem] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [rows, saleItems] = await Promise.all([listRefundsForSale(db, sale.id), listSaleItems(db, sale.id)]);
      setRefunds(rows);
      setVariantBySaleItem(Object.fromEntries(saleItems.map((i) => [i.id, i.variantId])));
      const items = await Promise.all(rows.map((r) => listRefundItems(db, r.id)));
      const byRefund: Record<number, RefundItem[]> = {};
      rows.forEach((r, i) => {
        byRefund[r.id] = items[i] ?? [];
      });
      setItemsByRefund(byRefund);
      setLoading(false);
    })();
  }, [db, sale.id]);

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
        <h2 style={{ margin: 0 }}>{t("journals.refundHistoryModal.title", { number: sale.number })}</h2>

        {loading ? (
          <p>{t("journals.refundHistoryModal.loading")}</p>
        ) : refunds.length === 0 ? (
          <p>{t("journals.refundHistoryModal.none")}</p>
        ) : (
          refunds.map((refund) => (
            <div
              key={refund.id}
              style={{
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                padding: 12,
                marginTop: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <strong>{refund.createdAt}</strong>
                <strong>{refund.total.toFixed(0)}</strong>
              </div>
              <p style={{ margin: "4px 0", color: "var(--color-text-muted)" }}>
                {METHOD_LABELS[refund.method as RefundMethod] ?? refund.method}
                {refund.reason ? ` — ${refund.reason}` : ""}
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {(itemsByRefund[refund.id] ?? []).map((item) => {
                  const variantId = variantBySaleItem[item.saleItemId];
                  return (
                    <li key={item.id}>
                      {variantId !== undefined ? variantLabel(variantId) : "—"} × {item.quantity} — {item.total.toFixed(0)}
                      {item.restocked ? t("journals.refundHistoryModal.restocked") : ""}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
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
            {t("journals.refundHistoryModal.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
