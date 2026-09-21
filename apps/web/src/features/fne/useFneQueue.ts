import { buildFneInvoicePayload, listPendingFneCertifications, markFneAttemptFailed, markFneCertified, onFneQueued } from "@gestion-boutique/core";
import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { useEffect, useRef } from "react";
import { certifyInvoice, FneApiError, resolveFneBaseUrl } from "./fneHttp";

// Traite la file d'attente de certification FNE (voir CLAUDE.md) sur CET
// appareil — monté une seule fois, comme UpdateBanner (voir App.tsx). Ne
// bloque jamais une vente : toute la logique ici tourne APRÈS qu'une vente
// a déjà été créée et son ticket imprimé (voir SalesService.createSale, qui
// se contente de mettre en file). Un échec reste silencieux ici (le statut
// "failed" est visible dans Paramètres/le reçu) — pas de notification
// intrusive pour une opération best-effort en arrière-plan.
export function useFneQueue(db: Database): void {
  const processingRef = useRef(false);

  useEffect(() => {
    const process = async () => {
      if (processingRef.current) return;
      processingRef.current = true;
      try {
        const settings = await db.select().from(schema.businessSettings).where(eq(schema.businessSettings.id, 1)).get();
        if (!settings?.fneEnabled || !settings.fneApiKey) return;
        const baseUrl = resolveFneBaseUrl(settings.fneEnvironment === "prod" ? "prod" : "test", settings.fneApiBaseUrl);
        if (!baseUrl) return;

        const pending = await listPendingFneCertifications(db);
        for (const entry of pending) {
          const sale = await db.select().from(schema.sales).where(eq(schema.sales.id, entry.saleId)).get();
          if (!sale) continue;
          const items = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, entry.saleId));
          const customer = sale.customerId != null ? (await db.select().from(schema.customers).where(eq(schema.customers.id, sale.customerId)).get()) ?? null : null;

          const payload = buildFneInvoicePayload(sale, items, customer, settings);
          try {
            const result = await certifyInvoice(payload, { apiKey: settings.fneApiKey, baseUrl });
            await markFneCertified(db, entry.queueId, entry.saleId, result);
          } catch (err) {
            const message = err instanceof FneApiError ? err.message : err instanceof Error ? err.message : "Erreur inconnue";
            await markFneAttemptFailed(db, entry.queueId, entry.saleId, message);
          }
        }
      } finally {
        processingRef.current = false;
      }
    };

    const handleOnline = () => void process();

    void process();
    const unsubscribe = onFneQueued(() => void process());
    window.addEventListener("online", handleOnline);
    const interval = setInterval(() => void process(), 5 * 60 * 1000);

    return () => {
      unsubscribe();
      window.removeEventListener("online", handleOnline);
      clearInterval(interval);
    };
  }, [db]);
}
