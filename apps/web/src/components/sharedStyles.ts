import type { CSSProperties } from "react";

export const pageStyle: CSSProperties = {
  maxWidth: 960,
  margin: "0 auto",
  // clamp() plutôt qu'une valeur fixe : réduit la marge sur un petit écran
  // (moins d'espace perdu sur les côtés) sans avoir besoin d'une media query.
  padding: "clamp(12px, 4vw, 24px)",
};

export const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  background: "var(--color-bg-elevated)",
  padding: 24,
  borderRadius: "var(--radius-lg)",
  marginTop: 24,
  border: "1px solid var(--color-border)",
  boxShadow: "var(--shadow-card)",
};

export const inputStyle: CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 6,
  padding: "10px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-border)",
  background: "var(--color-bg)",
  color: "var(--color-text)",
  fontSize: 16,
};

export const primaryButtonStyle: CSSProperties = {
  padding: "12px 18px",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--gradient-accent)",
  color: "#0f172a",
  fontWeight: 700,
  fontSize: 16,
  cursor: "pointer",
  boxShadow: "0 4px 14px -4px rgba(56, 189, 248, 0.5)",
};

export const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  marginTop: 16,
};

export const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "2px solid var(--color-border)",
  color: "var(--color-text-muted)",
  fontWeight: 600,
  fontSize: 13,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

export const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--color-border)",
};

const BADGE_COLORS: Record<"ok" | "warning" | "danger" | "info", { bg: string; fg: string }> = {
  ok: { bg: "#14532d", fg: "#86efac" },
  warning: { bg: "#7c2d12", fg: "#fdba74" },
  danger: { bg: "#7f1d1d", fg: "#fca5a5" },
  info: { bg: "#312e81", fg: "#a5b4fc" },
};

export const badgeStyle = (variant: "ok" | "warning" | "danger" | "info"): CSSProperties => ({
  display: "inline-block",
  padding: "3px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 700,
  background: BADGE_COLORS[variant].bg,
  color: BADGE_COLORS[variant].fg,
});
