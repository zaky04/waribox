import {
  collectAggregateAlerts,
  collectEventAlerts,
  getSettings,
  isAlertSeverity,
  isRelayDevice,
  listUnsentAlerts,
  markAlertFailed,
  markAlertSent,
  queueDailySummaryIfDue,
  queueReminderDigest,
} from "@gestion-boutique/core";
import type { Database } from "@gestion-boutique/database";
import { useEffect, useRef } from "react";
import { sendAlertText } from "./alertHttp";

// Détecte ce qui mérite l'attention du patron et l'envoie, sur CET appareil, tant que l'application est ouverte
// (aucune tâche de fond hors de l'application : un téléphone ou un PC éteint n'envoie rien). Monté une seule fois,
// comme useFneQueue. Sans adresse d'envoi ni téléphone à notifier, la fonction est inactive : rien n'est
// analysé ni mis en file.
const TICK_MS = 60 * 1000;

export function useAlertDispatcher(db: Database): void {
  const runningRef = useRef(false);

  useEffect(() => {
    const run = async () => {
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        const settings = await getSettings(db);
        const url = settings.alertChannelUrl?.trim() || null;
        const phone = settings.lowStockAlertPhone?.trim() || null;
        if (!url && !phone) return;
        const minSeverity = isAlertSeverity(settings.alertMinSeverity) ? settings.alertMinSeverity : "warning";
        const options = { minSeverity, businessName: settings.businessName };

        await collectEventAlerts(db, options);
        // Les signaux globaux et le résumé se calculent sur le Maître ou en mode Solo : un appareil relié verrait
        // les mêmes données et enverrait tout en double.
        if (!isRelayDevice()) {
          await collectAggregateAlerts(db, {
            ...options,
            thresholds: {
              refund: settings.alertRefundPercent,
              loss: settings.alertLossPercent,
              discount: settings.alertDiscountPercent,
              staleDays: settings.staleTicketDays,
              pendingHours: settings.approvalPendingAlertHours,
            },
          });
          await queueDailySummaryIfDue(db, { time: settings.dailySummaryTime, businessName: settings.businessName });
          await queueReminderDigest(db, new Date(), settings.businessName);
        }

        if (!url) return; // pas d'envoi automatique : les alertes attendent dans Contrôles (WhatsApp en un geste)
        for (const alert of await listUnsentAlerts(db)) {
          try {
            await sendAlertText(url, alert.text, phone);
            await markAlertSent(db, alert.id, "url");
          } catch (err) {
            await markAlertFailed(db, alert.id, err instanceof Error ? err.message : String(err));
            break; // le réseau est probablement coupé : inutile d'insister sur les suivantes
          }
        }
      } catch (err) {
        console.error("alertes", err);
      } finally {
        runningRef.current = false;
      }
    };

    void run();
    const timer = window.setInterval(() => void run(), TICK_MS);
    const onOnline = () => void run();
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [db]);
}
