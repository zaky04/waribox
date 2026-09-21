import {
  FNE_SIGN_INVOICE_ENDPOINT,
  FNE_TEST_BASE_URL,
  type FneApiErrorPayload,
  type FneCertificationResult,
  type FneInvoicePayload,
} from "@gestion-boutique/core";
import { isTauriRuntime } from "../settings/tauriRuntime";

// Appel HTTP réel vers la FNE (Facture Normalisée Électronique, Côte
// d'Ivoire, DGI) — voir CLAUDE.md. `packages/core/src/fne/` ne construit que
// le payload (pur, testable) ; c'est ici, comme pour le mode réseau
// (apps/web/src/features/network vs packages/network), que le vrai `fetch`
// part.
//
// Sous Tauri (desktop ou Android), passe par `@tauri-apps/plugin-http` —
// requête HTTP native côté Rust, qui ignore CORS/le blocage de contenu mixte
// du WebView (le bac à sable DGI est en `http://` simple, pas HTTPS). Hors
// Tauri (PWA/navigateur), repli sur `fetch()` classique en best-effort :
// fonctionnera seulement si le navigateur ne bloque pas l'appel — pas de
// garantie, voir CLAUDE.md.
async function resolveFetch(): Promise<typeof fetch> {
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch as unknown as typeof fetch;
  }
  return fetch;
}

export class FneApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
  ) {
    super(message);
  }
}

export interface FneConnectionConfig {
  apiKey: string;
  baseUrl: string; // FNE_TEST_BASE_URL en environnement 'test', fneApiBaseUrl saisi par l'utilisateur en 'prod'
}

/** Certifie une facture — lève `FneApiError` en cas d'échec (réseau, auth, validation). */
export async function certifyInvoice(payload: FneInvoicePayload, config: FneConnectionConfig): Promise<FneCertificationResult> {
  const doFetch = await resolveFetch();
  const url = `${config.baseUrl.replace(/\/$/, "")}${FNE_SIGN_INVOICE_ENDPOINT}`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new FneApiError(err instanceof Error ? err.message : "Connexion au serveur FNE impossible", null);
  }

  const data = (await response.json().catch(() => null)) as (Record<string, unknown> & Partial<FneApiErrorPayload>) | null;

  if (!response.ok) {
    throw new FneApiError(data?.message ?? `Erreur FNE (HTTP ${response.status})`, response.status);
  }
  if (!data) {
    throw new FneApiError("Réponse FNE invalide (JSON attendu)", response.status);
  }

  return {
    ncc: typeof data.ncc === "string" ? data.ncc : "",
    reference: typeof data.reference === "string" ? data.reference : "",
    token: typeof data.token === "string" ? data.token : "",
    warning: data.warning === true,
    balanceSticker: typeof data.balance_sticker === "number" ? data.balance_sticker : 0,
  };
}

/** URL effective selon l'environnement configuré — voir Paramètres. */
export function resolveFneBaseUrl(environment: "test" | "prod", prodBaseUrl: string | null): string {
  return environment === "prod" ? (prodBaseUrl ?? "") : FNE_TEST_BASE_URL;
}
