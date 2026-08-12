import { schema } from "@gestion-boutique/database";
import { useState } from "react";
import { useThemeStore } from "../../stores/theme";
import { StoreSwitcher } from "../stores/StoreSwitcher";
import { ChangePasswordModal } from "./ChangePasswordModal";
import { useAuth } from "./useAuth";

type Store = typeof schema.stores.$inferSelect;

interface TopBarProps {
  multiStoreEnabled: boolean;
  stores: Store[];
}

export function TopBar({ multiStoreEnabled, stores }: TopBarProps) {
  const { user, lock, logout, isImpersonating, impersonatorUser, returnToSelf } = useAuth();
  const { theme, toggleTheme } = useThemeStore();
  const [showPasswordModal, setShowPasswordModal] = useState(false);

  return (
    <header style={{ display: "flex", flexDirection: "column" }}>
      {isImpersonating && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 24px",
            background: "#7c2d12",
            color: "#fdba74",
            fontSize: 14,
          }}
        >
          <span>
            Connecté en tant que <strong>{user?.fullName}</strong> — session ouverte par{" "}
            {impersonatorUser?.fullName}
          </span>
          <button
            onClick={returnToSelf}
            style={{
              background: "transparent",
              border: "1px solid #fdba74",
              color: "#fdba74",
              borderRadius: 8,
              padding: "4px 10px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Revenir à mon compte
          </button>
        </div>
      )}
      <div
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
          <StoreSwitcher enabled={multiStoreEnabled} stores={stores} />
          <button
            onClick={() => setShowPasswordModal(true)}
            style={{
              background: "transparent",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
              borderRadius: 8,
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            Mon mot de passe
          </button>
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
      </div>
      {showPasswordModal && <ChangePasswordModal onClose={() => setShowPasswordModal(false)} />}
    </header>
  );
}
