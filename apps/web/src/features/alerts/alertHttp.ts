import { buildAlertRequestUrl } from "@gestion-boutique/core";
import { isTauriRuntime } from "../settings/tauriRuntime";

// Envoi d'un message par l'adresse (URL) choisie par le patron — voir packages/core/src/domain/alertChannel.ts.
// Sous Tauri : requête HTTP native (plugin-http, ignore CORS). Dans un navigateur : la plupart de ces services
// (CallMeBot, ntfy...) ne renvoient pas d'en-têtes CORS ; la requête part quand même (mode « no-cors ») mais sa
// réponse est illisible — on la considère envoyée si le réseau n'a pas échoué.
export async function sendAlertText(template: string, text: string, phone?: string | null): Promise<void> {
  const url = buildAlertRequestUrl(template, text, phone);
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const response = await tauriFetch(url, { method: "GET" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return;
  }
  await fetch(url, { method: "GET", mode: "no-cors", cache: "no-store" });
}
