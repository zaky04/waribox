import { getSettings, listRecentAlerts, markAlertSent, retryFailedAlerts, MAX_ALERT_ATTEMPTS } from "@gestion-boutique/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { badgeStyle, cardStyle, primaryButtonStyle } from "../../components/sharedStyles";
import { formatDateTime } from "../../lib/dateTime";
import { openWhatsApp } from "../../lib/whatsapp";

type AlertRow = Awaited<ReturnType<typeof listRecentAlerts>>[number];

// Alertes détectées pour le patron (voir useAlertDispatcher) : ce qui est parti, ce qui attend, ce qui a échoué.
// Sans canal automatique configuré, chaque alerte en attente s'envoie par WhatsApp en un geste.
export function AlertsPanel() {
  const { t } = useTranslation();
  const db = useDatabase();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [phone, setPhone] = useState("");
  const [countryCode, setCountryCode] = useState<string | null>(null);
  const [hasChannel, setHasChannel] = useState(false);

  const refresh = useCallback(async () => {
    const [rows, settings] = await Promise.all([listRecentAlerts(db, 30), getSettings(db)]);
    setAlerts(rows);
    setPhone(settings.lowStockAlertPhone ?? "");
    setCountryCode(settings.whatsappCountryCode ?? null);
    setHasChannel(!!settings.alertChannelUrl?.trim());
  }, [db]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const pending = alerts.filter((a) => !a.sentAt);

  const sendByWhatsApp = async (rows: AlertRow[]) => {
    if (rows.length === 0) return;
    await openWhatsApp(phone, countryCode, rows.map((r) => r.text).join("\n\n"));
    for (const row of rows) await markAlertSent(db, row.id, "whatsapp");
    await refresh();
  };

  if (alerts.length === 0 && !phone && !hasChannel) return null;

  return (
    <div style={{ ...cardStyle, borderColor: pending.some((a) => a.severity === "danger") ? "var(--color-danger)" : undefined }}>
      <strong>{t("alertsPanel.title", { count: pending.length })}</strong>
      <p style={{ margin: 0, color: "var(--color-text-muted)", fontSize: 13 }}>{hasChannel ? t("alertsPanel.hintAuto") : t("alertsPanel.hintManual")}</p>
      {alerts.length === 0 ? (
        <p style={{ margin: 0, color: "var(--color-text-muted)" }}>{t("alertsPanel.none")}</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {alerts.map((a) => {
            const abandoned = !a.sentAt && a.attempts >= MAX_ALERT_ATTEMPTS;
            return (
              <li key={a.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", borderBottom: "1px dashed var(--color-rule-strong)", paddingBottom: 8 }}>
                <span style={{ flex: "1 1 260px", minWidth: 0, overflowWrap: "anywhere", color: a.severity === "danger" ? "var(--color-danger)" : "var(--color-text)" }}>
                  <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>{formatDateTime(a.createdAt)} — </span>
                  {a.text}
                </span>
                {a.sentAt ? (
                  <span style={badgeStyle("ok")}>{t(a.channel === "whatsapp" ? "alertsPanel.sentWhatsApp" : "alertsPanel.sentAuto")}</span>
                ) : (
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={badgeStyle(abandoned ? "danger" : "warning")} title={a.lastError ?? undefined}>
                      {abandoned ? t("alertsPanel.failed") : t("alertsPanel.waiting")}
                    </span>
                    <button style={{ ...primaryButtonStyle, padding: "4px 10px", fontSize: 12 }} disabled={!phone} onClick={() => void sendByWhatsApp([a])}>
                      {t("alertsPanel.sendWhatsApp")}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pending.length > 1 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={primaryButtonStyle} disabled={!phone} onClick={() => void sendByWhatsApp(pending)}>
            {t("alertsPanel.sendAll", { count: pending.length })}
          </button>
        </div>
      )}
      {pending.some((a) => a.attempts >= MAX_ALERT_ATTEMPTS) && (
        <button
          style={{ ...primaryButtonStyle, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)", alignSelf: "flex-start" }}
          onClick={async () => {
            await retryFailedAlerts(db);
            await refresh();
          }}
        >
          {t("alertsPanel.retry")}
        </button>
      )}
      {!phone && pending.length > 0 && <p style={{ margin: 0, color: "var(--color-warning)", fontSize: 13 }}>{t("alertsPanel.noPhone")}</p>}
    </div>
  );
}
