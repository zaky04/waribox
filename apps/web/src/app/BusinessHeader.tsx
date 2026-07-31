interface BusinessHeaderProps {
  businessName: string | null;
  logoDataUrl: string | null;
}

export function BusinessHeader({ businessName, logoDataUrl }: BusinessHeaderProps) {
  if (!businessName && !logoDataUrl) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 24px",
        background: "var(--color-bg)",
        borderBottom: "1px solid var(--color-bg-elevated)",
      }}
    >
      {logoDataUrl && (
        <img
          src={logoDataUrl}
          alt="Logo"
          style={{ width: 32, height: 32, objectFit: "contain", background: "#fff", borderRadius: 6 }}
        />
      )}
      {businessName && <strong style={{ color: "var(--color-text)", fontSize: 16 }}>{businessName}</strong>}
    </div>
  );
}
