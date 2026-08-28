import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cardStyle, inputStyle, pageStyle, primaryButtonStyle } from "../../components/sharedStyles";

export function OpenCashSessionScreen({ onOpen }: { onOpen: (amount: number) => Promise<void> }) {
  const { t } = useTranslation();
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
      <h1>{t("sales.openSession.title")}</h1>
      <p style={{ color: "var(--color-text-muted)" }}>{t("sales.openSession.hint")}</p>
      <div style={cardStyle}>
        <label>
          {t("sales.openSession.openingAmount")}
          <input
            style={inputStyle}
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <button style={primaryButtonStyle} onClick={handleOpen} disabled={loading}>
          {loading ? t("sales.openSession.opening") : t("sales.openSession.open")}
        </button>
      </div>
    </main>
  );
}
