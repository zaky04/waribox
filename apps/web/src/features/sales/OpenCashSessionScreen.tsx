import { useState } from "react";
import { cardStyle, inputStyle, pageStyle, primaryButtonStyle } from "../../components/sharedStyles";

export function OpenCashSessionScreen({ onOpen }: { onOpen: (amount: number) => Promise<void> }) {
  const [amount, setAmount] = useState("0");
  const [loading, setLoading] = useState(false);

  const handleOpen = async () => {
    setLoading(true);
    try {
      await onOpen(Number(amount) || 0);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={pageStyle}>
      <h1>Ouverture de caisse</h1>
      <p style={{ color: "var(--color-text-muted)" }}>
        Indique le montant en espèces présent dans le tiroir avant de commencer les ventes.
      </p>
      <div style={cardStyle}>
        <label>
          Montant d'ouverture
          <input
            style={inputStyle}
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <button style={primaryButtonStyle} onClick={handleOpen} disabled={loading}>
          {loading ? "Ouverture..." : "Ouvrir la caisse"}
        </button>
      </div>
    </main>
  );
}
