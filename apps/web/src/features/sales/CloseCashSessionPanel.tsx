import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";

interface CloseCashSessionPanelProps {
  onClose: (closingAmount: number) => Promise<void>;
  onCancel: () => void;
}

// Clôture EN AVEUGLE : le montant attendu n'est jamais affiché avant la
// validation — le caissier doit réellement compter le tiroir au lieu de
// recopier le chiffre du système. L'écart est calculé (côté service) et montré
// après la clôture.
export function CloseCashSessionPanel({ onClose, onCancel }: CloseCashSessionPanelProps) {
  const { t } = useTranslation();
  const [counted, setCounted] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = async () => {
    setError(null);
    setLoading(true);
    try {
      await onClose(Number(counted));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sales.closeSession.error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={cardStyle}>
      <strong>{t("sales.closeSession.title")}</strong>
      <p style={{ color: "var(--color-text-muted)", margin: 0, fontSize: 13 }}>{t("sales.closeSession.blindHint")}</p>
      <label>
        {t("sales.closeSession.countedAmount")}
        <input
          style={inputStyle}
          type="number"
          step="any"
          min={0}
          value={counted}
          onChange={(e) => setCounted(e.target.value)}
          autoFocus
        />
      </label>
      {error && <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <button style={primaryButtonStyle} onClick={handleClose} disabled={loading || counted === "" || Number(counted) < 0}>
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
