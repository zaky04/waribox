import type { CSSProperties } from "react";

export const authCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  background: "var(--color-bg-elevated)",
  padding: 32,
  borderRadius: "var(--radius-lg)",
  marginTop: 24,
  border: "1px solid var(--color-border)",
  boxShadow: "var(--shadow-card-strong)",
};

export const authInputStyle: CSSProperties = {
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

export const authPrimaryButtonStyle: CSSProperties = {
  padding: "12px 16px",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--gradient-accent)",
  color: "var(--color-on-accent)",
  fontWeight: 700,
  fontSize: 16,
  cursor: "pointer",
};
