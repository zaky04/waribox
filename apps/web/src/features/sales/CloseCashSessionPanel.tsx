import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";

interface CloseCashSessionPanelProps {
  expectedAmount: number;
  onClose: (closingAmount: number, expectedAmount: number) => Promise<void>;
  onCancel: () => void;
}

export function CloseCashSessionPanel({ expectedAmount, onClose, onCancel }: CloseCashSessionPanelProps) {
  const { t } = useTranslation();
  const [counted, setCounted] = useState(String(expectedAmount));
  const [loading, setLoading] = useState(false);

  const countedNumber = Number(counted) || 0;
  const difference = countedNumber - expectedAmount;

  const handleClose = async () => {
    setLoading(true);
    try {
      await onClose(countedNumber, expectedAmount);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={cardStyle}>
      <strong>{t("sales.closeSession.title")}</strong>
      <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
        {t("sales.closeSession.expectedAmount")} {expectedAmount}
      </p>
      <label>
        {t("sales.closeSession.countedAmount")}
        <input style={inputStyle} type="number" value={counted} onChange={(e) => setCounted(e.target.value)} />
      </label>
      <p style={{ color: difference === 0 ? "var(--color-success)" : "var(--color-warning)" }}>
        {t("sales.closeSession.difference")} {difference > 0 ? "+" : ""}
        {difference}
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <button style={primaryButtonStyle} onClick={handleClose} disabled={loading}>
          {loading ? t("sales.closeSession.closing") : t("sales.closeSession.confirm")}
        </button>
        <button
          onClick={onCancel}
          style={{ background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)", borderRadius: 8, padding: "0 16px" }}
        >
          {t("sales.closeSession.cancel")}
        </button>
      </div>
    </div>
  );
}
