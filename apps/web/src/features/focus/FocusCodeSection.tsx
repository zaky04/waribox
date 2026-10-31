import { FOCUS_CODE_MIN_LENGTH, hasFocusCode, setFocusCode } from "@gestion-boutique/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";
import { useAuth } from "../auth/useAuth";
import { useFocus } from "./FocusProvider";

// Configuration → Sécurité : le code qui permet de quitter le mode focus
// (plein écran) sur PC et tablette. Secret à part du code de maintenance.
export function FocusCodeSection() {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();
  const { available } = useFocus();
  const [isSet, setIsSet] = useState(false);
  const [currentCode, setCurrentCode] = useState("");
  const [forgotten, setForgotten] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => setIsSet(await hasFocusCode(db)), [db]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    if (!user) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await setFocusCode(db, {
        newCode: newCode.trim(),
        currentCode: isSet && !forgotten ? currentCode.trim() : undefined,
        maintenanceCode: isSet && forgotten ? currentCode.trim() : undefined,
        userId: user.id,
        actingPermissions: user.permissions,
      });
      setIsSet(true);
      setCurrentCode("");
      setNewCode("");
      setForgotten(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("focus.settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={cardStyle}>
      <strong>{t("focus.settings.heading")}</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("focus.settings.hint")}</p>
      {!available && <p style={{ color: "var(--color-text-muted)", fontSize: 12.5, margin: 0 }}>{t("focus.settings.unavailableHere")}</p>}
      <p style={{ fontSize: 13, margin: 0, color: isSet ? "var(--color-success)" : "var(--color-warning)" }}>
        {isSet ? t("focus.settings.codeSet") : t("focus.settings.codeMissing")}
      </p>
      {isSet && (
        <label>
          {t(forgotten ? "focus.settings.maintenanceCode" : "focus.settings.currentCode")}
          <input style={inputStyle} type="password" autoComplete="off" value={currentCode} onChange={(e) => setCurrentCode(e.target.value)} />
        </label>
      )}
      {isSet && (
        <button
          type="button"
          onClick={() => {
            setForgotten((v) => !v);
            setCurrentCode("");
          }}
          style={{ alignSelf: "flex-start", background: "transparent", border: "none", color: "var(--color-text-muted)", textDecoration: "underline", cursor: "pointer", fontSize: 13, padding: 0 }}
        >
          {t(forgotten ? "focus.settings.useFocusCode" : "focus.settings.forgotten")}
        </button>
      )}
      <label>
        {t(isSet ? "focus.settings.newCode" : "focus.settings.setCode")}
        <input
          style={inputStyle}
          type="password"
          autoComplete="off"
          value={newCode}
          onChange={(e) => setNewCode(e.target.value)}
          placeholder={t("focus.settings.codePlaceholder", { min: FOCUS_CODE_MIN_LENGTH })}
        />
      </label>
      {error && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{error}</p>}
      {saved && <p style={{ color: "var(--color-success)", fontSize: 13 }}>{t("focus.settings.saved")}</p>}
      <button
        style={{ ...primaryButtonStyle, padding: "8px 14px", fontSize: 14, alignSelf: "flex-start" }}
        onClick={save}
        disabled={saving || !newCode || (isSet && !currentCode)}
      >
        {saving ? t("focus.settings.saving") : t("focus.settings.save")}
      </button>
    </div>
  );
}
