import { getRoleDisplayName } from "@gestion-boutique/core";
import type { Language } from "@gestion-boutique/i18n";
import { schema } from "@gestion-boutique/database";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLanguageStore } from "../../stores/language";
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
  const { language, setLanguage } = useLanguageStore();
  const { t } = useTranslation();
  const [showPasswordModal, setShowPasswordModal] = useState(false);

  return (
    <header style={{ display: "flex", flexDirection: "column" }}>
      {isImpersonating && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            padding: "8px 16px",
            background: "#7c2d12",
            color: "#fdba74",
            fontSize: 14,
          }}
        >
          <span>
            {t("topbar.impersonatingPrefix")} <strong>{user?.fullName}</strong> {t("topbar.impersonatingSuffix")}{" "}
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
            {t("topbar.returnToSelf")}
          </button>
        </div>
      )}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          background: "var(--color-bg-elevated)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div>
          <strong>{user?.fullName}</strong>{" "}
          <span style={{ color: "var(--color-text-muted)" }}>— {user?.roleName && getRoleDisplayName(user.roleName)}</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
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
            {t("topbar.myPassword")}
          </button>
          <select
            aria-label={t("topbar.language")}
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            style={{
              background: "transparent",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
              borderRadius: 8,
              padding: "6px 8px",
              cursor: "pointer",
            }}
          >
            <option value="fr">FR</option>
            <option value="en">EN</option>
          </select>
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
            {theme === "dark" ? t("topbar.themeDark") : t("topbar.themeLight")}
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
            {t("topbar.lock")}
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
            {t("topbar.logout")}
          </button>
        </div>
      </div>
      {showPasswordModal && <ChangePasswordModal onClose={() => setShowPasswordModal(false)} />}
    </header>
  );
}
