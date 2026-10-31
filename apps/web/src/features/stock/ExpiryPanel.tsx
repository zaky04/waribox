import {
  expiryTier,
  getBatchRemainingMap,
  listExpiringBatches,
  todayISO,
  writeOffExpiredBatches,
  type ExpiringBatch,
  type ExpiryTier,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { badgeStyle, cardStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { formatMoney } from "../../lib/format";
import { useApproval } from "../approval/ApprovalProvider";
import { useAuth } from "../auth/useAuth";

type Product = typeof schema.products.$inferSelect;

interface Row {
  entry: ExpiringBatch;
  remaining: number;
  tier: ExpiryTier;
  value: number;
}

const TIER_ORDER: ExpiryTier[] = ["expired", "within30", "within60", "within90"];

const TIER_COLOR: Record<ExpiryTier, string> = {
  expired: "var(--color-danger)",
  within30: "var(--color-warning)",
  within60: "var(--color-caution)",
  within90: "var(--color-text-muted)",
  later: "var(--color-text-muted)",
};

interface Props {
  products: Product[];
  storeId?: number;
  canWriteOff: boolean;
  // Appelé après un rebut pour que la page recharge ses niveaux de stock.
  onChanged: () => void | Promise<void>;
  // Bouton « Notifier sur WhatsApp » existant (message des péremptions proches).
  onNotify?: () => void;
}

// Péremptions en 4 paliers (périmé / ≤30 / ≤60 / ≤90 jours) avec la valeur au coût
// de chaque palier, et le rebut tracé des lots périmés. Un lot périmé n'est plus
// vendable (voir StockService.getSellableQuantity) : il doit partir ici.
export function ExpiryPanel({ products, storeId, canWriteOff, onChanged, onNotify }: Props) {
  const db = useDatabase();
  const { user } = useAuth();
  const approval = useApproval();
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    const today = todayISO();
    const entries = await listExpiringBatches(db, 90, storeId);
    const remaining = await getBatchRemainingMap(db, entries.map((e) => e.batch.id));
    const next: Row[] = [];
    for (const entry of entries) {
      const left = remaining.get(entry.batch.id) ?? 0;
      if (left <= 0) continue;
      const product = products.find((p) => p.id === entry.variant.productId);
      next.push({
        entry,
        remaining: left,
        tier: expiryTier(entry.batch.expiryDate, today),
        value: left * (entry.batch.unitCost ?? product?.purchasePrice ?? 0),
      });
    }
    next.sort((a, b) => (a.entry.batch.expiryDate ?? "").localeCompare(b.entry.batch.expiryDate ?? ""));
    setRows(next);
  }, [db, storeId, products]);

  useEffect(() => {
    void load();
  }, [load]);

  if (rows.length === 0 && !result) return null;

  const expired = rows.filter((r) => r.tier === "expired");
  const expiredValue = expired.reduce((sum, r) => sum + r.value, 0);

  const handleWriteOff = async () => {
    if (!user) return;
    setError(null);
    setResult(null);
    if (!window.confirm(t("pharmacy.writeOffConfirm", { count: expired.length, value: formatMoney(expiredValue) }))) return;
    setWorking(true);
    try {
      const done = await approval.run((a) =>
        writeOffExpiredBatches(db, { userId: user.id, storeId, approval: a }, user.permissions),
      );
      setResult(t("pharmacy.writeOffDone", { batches: done.batches, units: done.units, value: formatMoney(done.value) }));
      await load();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pharmacy.writeOffFailed"));
    } finally {
      setWorking(false);
    }
  };

  const productName = (productId: number) => products.find((p) => p.id === productId)?.name ?? "—";

  return (
    <div style={{ ...cardStyle, borderLeft: `4px solid ${expired.length > 0 ? "var(--color-danger)" : "var(--color-caution)"}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <strong>{t("pharmacy.expiryTitle")}</strong>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {onNotify && (
            <button style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 13, whiteSpace: "nowrap" }} onClick={onNotify}>
              {t("stock.notifyWhatsapp")}
            </button>
          )}
          {canWriteOff && expired.length > 0 && (
            <button
              style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 13, whiteSpace: "nowrap" }}
              onClick={handleWriteOff}
              disabled={working}
            >
              {t("pharmacy.writeOff")}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {TIER_ORDER.map((tier) => {
          const tierRows = rows.filter((r) => r.tier === tier);
          return (
            <span key={tier} style={{ ...badgeStyle("info"), color: TIER_COLOR[tier], border: `1px solid ${TIER_COLOR[tier]}` }}>
              {t(`pharmacy.tiers.${tier}`)} : {tierRows.length}
              {tier === "expired" && tierRows.length > 0 ? ` (${formatMoney(expiredValue)})` : ""}
            </span>
          );
        })}
      </div>

      {expired.length > 0 && <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{t("pharmacy.expiredNotSellable")}</p>}
      {error && <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{error}</p>}
      {result && <p style={{ color: "var(--color-success)", fontSize: 13, margin: 0 }}>{result}</p>}

      {rows.length > 0 && (
        <div className="table-scroll">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t("pharmacy.product")}</th>
                <th style={thStyle}>{t("pharmacy.lotNumber")}</th>
                <th style={thStyle}>{t("pharmacy.expiryDate")}</th>
                <th style={thStyle}>{t("pharmacy.quantity")}</th>
                <th style={thStyle}>{t("pharmacy.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.entry.batch.id}>
                  <td style={tdStyle}>{productName(r.entry.variant.productId)}</td>
                  <td style={tdStyle}>{r.entry.batch.lotNumber || "—"}</td>
                  <td style={tdStyle}>{r.entry.batch.expiryDate}</td>
                  <td style={tdStyle}>{r.remaining}</td>
                  <td style={{ ...tdStyle, color: TIER_COLOR[r.tier], fontWeight: 600 }}>{t(`pharmacy.tiers.${r.tier}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
