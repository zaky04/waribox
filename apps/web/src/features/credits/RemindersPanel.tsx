import { buildReminderText, getSettings, listDueReminders, recordReminderSent, type DueReminder } from "@gestion-boutique/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { badgeStyle, cardStyle, primaryButtonStyle } from "../../components/sharedStyles";
import { formatMoney } from "../../lib/format";
import { openWhatsApp } from "../../lib/whatsapp";

// Relances de créances à faire aujourd'hui (voir ReminderService) : une ligne par client, au ton de l'étape,
// envoyée par WhatsApp en un geste puis notée pour que la suivante n'apparaisse qu'à son échéance.
export function RemindersPanel({ onChanged }: { onChanged?: () => void }) {
  const { t } = useTranslation();
  const db = useDatabase();
  const [reminders, setReminders] = useState<DueReminder[]>([]);
  const [business, setBusiness] = useState<string | null>(null);
  const [countryCode, setCountryCode] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [due, settings] = await Promise.all([listDueReminders(db), getSettings(db)]);
    setReminders(due);
    setBusiness(settings.businessName ?? null);
    setCountryCode(settings.whatsappCountryCode ?? null);
  }, [db]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (reminders.length === 0) return null;

  const send = async (reminder: DueReminder) => {
    if (!reminder.phone) return;
    await openWhatsApp(reminder.phone, countryCode, buildReminderText(reminder, business));
    await recordReminderSent(db, reminder.creditId, reminder.step);
    await refresh();
    onChanged?.();
  };

  return (
    <div style={{ ...cardStyle, marginTop: 0, borderColor: reminders.some((r) => r.tone === "final") ? "var(--color-danger)" : "var(--color-warning)" }}>
      <strong>{t("remindersPanel.title", { count: reminders.length })}</strong>
      <p style={{ margin: 0, color: "var(--color-text-muted)", fontSize: 13 }}>{t("remindersPanel.hint")}</p>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {reminders.map((r) => (
          <li key={r.creditId} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", borderBottom: "1px dashed var(--color-rule-strong)", paddingBottom: 8 }}>
            <span style={{ flex: "1 1 240px", minWidth: 0 }}>
              <strong>{r.customerName}</strong> — {formatMoney(r.amount)}
              <span style={{ color: "var(--color-text-muted)", fontSize: 12.5 }}>
                {" "}
                · {t("remindersPanel.late", { days: r.daysLate })} {r.reference && `· ${r.reference}`}
              </span>
            </span>
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={badgeStyle(r.tone === "final" ? "danger" : r.tone === "firm" ? "warning" : "ok")}>{t(`remindersPanel.tone_${r.tone}`)}</span>
              <button style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 13 }} disabled={!r.phone} title={r.phone ? undefined : t("remindersPanel.noPhone")} onClick={() => void send(r)}>
                {r.phone ? t("remindersPanel.send") : t("remindersPanel.noPhone")}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
