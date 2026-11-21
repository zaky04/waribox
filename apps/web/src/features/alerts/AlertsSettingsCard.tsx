import { getSettings, hasPermission, isAlertSeverity, updateSettings, type AlertSeverity } from "@gestion-boutique/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";
import { useAuth } from "../auth/useAuth";
import { sendAlertText } from "./alertHttp";

// Réglage des alertes au patron (Configuration) : adresse d'envoi automatique, gravité minimale, heure du résumé
// du jour. Carte autonome avec son propre bouton Enregistrer — elle ne touche pas aux autres réglages.
export function AlertsSettingsCard() {
  const { t } = useTranslation();
  const db = useDatabase();
  const { user } = useAuth();
  const canEdit = hasPermission(user?.permissions ?? {}, "manage_settings");
  const [url, setUrl] = useState("");
  const [severity, setSeverity] = useState<AlertSeverity>("warning");
  const [time, setTime] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getSettings(db).then((s) => {
      setUrl(s.alertChannelUrl ?? "");
      setSeverity(isAlertSeverity(s.alertMinSeverity) ? s.alertMinSeverity : "warning");
      setTime(s.dailySummaryTime ?? "");
      setPhone(s.lowStockAlertPhone ?? "");
    });
  }, [db]);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await updateSettings(db, { alertChannelUrl: url.trim(), alertMinSeverity: severity, dailySummaryTime: time }, user?.permissions ?? {});
      setMessage({ kind: "ok", text: t("alertsSettings.saved") });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await sendAlertText(url.trim(), t("alerts.test"), phone);
      setMessage({ kind: "ok", text: t("alertsSettings.testSent") });
    } catch (err) {
      setMessage({ kind: "error", text: t("alertsSettings.testFailed", { error: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={cardStyle}>
      <strong>{t("alertsSettings.title")}</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("alertsSettings.hint")}</p>
      <label>
        {t("alertsSettings.url")}
        <input style={inputStyle} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…{text}" disabled={!canEdit} />
      </label>
      <p style={{ color: "var(--color-text-muted)", fontSize: 12.5, margin: 0 }}>{t("alertsSettings.urlHint")}</p>
      <label>
        {t("alertsSettings.severity")}
        <select style={inputStyle} value={severity} onChange={(e) => setSeverity(e.target.value as AlertSeverity)} disabled={!canEdit}>
          <option value="info">{t("alertsSettings.severityInfo")}</option>
          <option value="warning">{t("alertsSettings.severityWarning")}</option>
          <option value="danger">{t("alertsSettings.severityDanger")}</option>
        </select>
      </label>
      <label>
        {t("alertsSettings.summaryTime")}
        <input style={inputStyle} type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={!canEdit} />
      </label>
      <p style={{ color: "var(--color-text-muted)", fontSize: 12.5, margin: 0 }}>{t("alertsSettings.summaryHint")}</p>
      {message && <p style={{ margin: 0, color: message.kind === "ok" ? "var(--color-success)" : "var(--color-danger)" }}>{message.text}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button style={primaryButtonStyle} onClick={() => void save()} disabled={busy || !canEdit}>
          {t("alertsSettings.save")}
        </button>
        <button
          style={{ ...primaryButtonStyle, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          onClick={() => void test()}
          disabled={busy || !url.trim()}
        >
          {t("alertsSettings.test")}
        </button>
      </div>
    </div>
  );
}
