import { useThemeStore } from "../../stores/theme";
import { useAuth } from "./useAuth";

export function TopBar() {
  const { user, lock, logout } = useAuth();
  const { theme, toggleTheme } = useThemeStore();

  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "12px 24px",
        background: "var(--color-bg-elevated)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <div>
        <strong>{user?.fullName}</strong>{" "}
        <span style={{ color: "var(--color-text-muted)" }}>— {user?.roleName}</span>
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <button
          onClick={toggleTheme}
          style={{
            background: "transparent",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
            borderRadius: 8,
            padding: "6px 12px",
            cursor: "pointer",
          }}
        >
          {theme === "dark" ? "🌙 Sombre" : "☀️ Clair"}
        </button>
        <button
          onClick={lock}
          style={{
            background: "transparent",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
            borderRadius: 8,
            padding: "6px 12px",
            cursor: "pointer",
          }}
        >
          Verrouiller
        </button>
        <button
          onClick={logout}
          style={{
            background: "transparent",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
            borderRadius: 8,
            padding: "6px 12px",
            cursor: "pointer",
          }}
        >
          Déconnexion
        </button>
      </div>
    </header>
  );
}
