import { useState } from "react";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";

interface CloseCashSessionPanelProps {
  expectedAmount: number;
  onClose: (closingAmount: number, expectedAmount: number) => Promise<void>;
  onCancel: () => void;
}

export function CloseCashSessionPanel({ expectedAmount, onClose, onCancel }: CloseCashSessionPanelProps) {
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
      <strong>Fermeture de caisse</strong>
      <p style={{ color: "var(--color-text-muted)", margin: 0 }}>Montant attendu (ouverture + encaissements espèces) : {expectedAmount}</p>
      <label>
        Montant compté dans le tiroir
        <input style={inputStyle} type="number" value={counted} onChange={(e) => setCounted(e.target.value)} />
      </label>
      <p style={{ color: difference === 0 ? "#86efac" : "#fdba74" }}>
        Écart : {difference > 0 ? "+" : ""}
        {difference}
      </p>
      <div style={{ display: "flex", gap: 12 }}>
        <button style={primaryButtonStyle} onClick={handleClose} disabled={loading}>
          {loading ? "Fermeture..." : "Confirmer la fermeture"}
        </button>
        <button
          onClick={onCancel}
          style={{ background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)", borderRadius: 8, padding: "0 16px" }}
        >
          Annuler
        </button>
      </div>
    </div>
  );
}
