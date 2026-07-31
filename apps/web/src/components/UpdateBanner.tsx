import { useRegisterSW } from "virtual:pwa-register/react";

export function UpdateBanner() {
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 16,
        padding: "10px 24px",
        background: "var(--color-bg-elevated)",
        borderBottom: "1px solid var(--color-border)",
        color: "var(--color-text)",
      }}
    >
      <span>Une nouvelle version de l'application est disponible.</span>
      <div style={{ display: "flex", gap: 8 }}>
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
          Mettre à jour
        </button>
        <button
          onClick={() => setNeedRefresh(false)}
          style={{ background: "transparent", border: "none", color: "var(--color-text-muted)", cursor: "pointer" }}
        >
          Plus tard
        </button>
      </div>
    </div>
  );
}
