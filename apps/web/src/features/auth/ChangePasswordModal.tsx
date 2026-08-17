import { changeOwnPassword } from "@gestion-boutique/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";
import { useAuth } from "./useAuth";

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setError(null);
    if (newPassword.length < 8) {
      setError(t("auth.changePassword.errors.passwordLength"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("auth.changePassword.errors.passwordMismatch"));
      return;
    }
    if (!user) return;

    setSaving(true);
    try {
      await changeOwnPassword(db, user.id, currentPassword, newPassword);
      setSaved(true);
      setTimeout(onClose, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.changePassword.errors.changeFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{ ...cardStyle, width: "min(380px, 100%)", maxHeight: "85vh", overflowY: "auto", marginTop: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: 0 }}>{t("auth.changePassword.title")}</h2>

        <label>
          {t("auth.changePassword.currentPassword")}
          <input
            style={inputStyle}
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </label>
        <label>
          {t("auth.changePassword.newPassword")}
          <input
            style={inputStyle}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={8}
          />
        </label>
        <label>
          {t("auth.changePassword.confirmPassword")}
          <input
            style={inputStyle}
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            minLength={8}
          />
        </label>

        {error && <p style={{ color: "#f87171" }}>{error}</p>}
        {saved && <p style={{ color: "#86efac" }}>{t("auth.changePassword.saved")}</p>}

        <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
          <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
            {saving ? t("auth.changePassword.saving") : t("auth.changePassword.save")}
          </button>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
              borderRadius: "var(--radius-md)",
              padding: "12px 18px",
              cursor: "pointer",
            }}
          >
            {t("auth.changePassword.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
