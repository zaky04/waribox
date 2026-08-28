import { useRegisterSW } from "virtual:pwa-register/react";
import { useTranslation } from "react-i18next";

export function UpdateBanner() {
  const { t } = useTranslation();
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 16,
        padding: "10px 24px",
        background: "var(--color-bg-elevated)",
        borderBottom: "1px solid var(--color-border)",
        color: "var(--color-text)",
      }}
    >
      <span>{t("updateBanner.message")}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          onClick={() => updateServiceWorker(true)}
          style={{
            padding: "6px 14px",
            borderRadius: "var(--radius-md)",
            border: "none",
            background: "var(--gradient-accent)",
            color: "#0f172a",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {t("updateBanner.update")}
        </button>
        <button
          onClick={() => setNeedRefresh(false)}
          style={{ background: "transparent", border: "none", color: "var(--color-text-muted)", cursor: "pointer" }}
        >
          {t("updateBanner.later")}
        </button>
      </div>
    </div>
  );
}
