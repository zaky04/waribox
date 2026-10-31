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
  color: "var(--color-on-accent)",
  fontWeight: 700,
  fontSize: 16,
  cursor: "pointer",
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

// Pastilles à plat : filet + texte de la couleur de statut, sans fond plein
// (direction "ticket de caisse", voir index.css) — suit les variables de
// statut, donc lisibles en clair comme en mode nuit.
const BADGE_COLORS: Record<"ok" | "warning" | "danger" | "info", string> = {
  ok: "var(--color-success)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
  info: "var(--color-text-muted)",
};

export const badgeStyle = (variant: "ok" | "warning" | "danger" | "info"): CSSProperties => ({
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 700,
  background: "transparent",
  border: "1px solid " + BADGE_COLORS[variant],
  color: BADGE_COLORS[variant],
});

// Montants : chiffres à chasse fixe (IBM Plex Mono), pour l'alignement des
// colonnes et l'allure "ticket".
export const amountStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
};
