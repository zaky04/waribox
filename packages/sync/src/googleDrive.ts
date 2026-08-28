import { t } from "@gestion-boutique/i18n";

interface GoogleTokenResponse {
  access_token: string;
  error?: string;
}

interface GoogleTokenClient {
  requestAccessToken(overrideConfig?: { prompt?: string }): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            callback: (response: GoogleTokenResponse) => void;
          }): GoogleTokenClient;
        };
      };
    };
  }
}

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";

let scriptLoadPromise: Promise<void> | null = null;

export function loadGoogleIdentityScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!scriptLoadPromise) {
    scriptLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(t("sync.errors.googleIdentityLoadFailed")));
      document.head.appendChild(script);
    });
  }
  return scriptLoadPromise;
}

let cachedTokenClient: GoogleTokenClient | null = null;
let cachedClientId: string | null = null;
let currentResolve: ((token: string) => void) | null = null;
let currentReject: ((err: Error) => void) | null = null;

function getTokenClient(clientId: string): GoogleTokenClient {
  if (!cachedTokenClient || cachedClientId !== clientId) {
    cachedClientId = clientId;
    cachedTokenClient = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          currentReject?.(new Error(response.error ?? t("sync.errors.driveConnectionDenied")));
        } else {
          currentResolve?.(response.access_token);
        }
        currentResolve = null;
        currentReject = null;
      },
    });
  }
  return cachedTokenClient;
}

// Flux implicite Google Identity Services (client public, sans backend) — le
// jeton obtenu est de courte durée et ne se rafraîchit pas silencieusement en
// arrière-plan indéfiniment. Une nouvelle connexion sera redemandée quand il
// expire, plutôt que d'échouer silencieusement.
const TOKEN_REQUEST_TIMEOUT_MS = 60_000;

export async function requestGoogleDriveAccessToken(clientId: string): Promise<string> {
  await loadGoogleIdentityScript();
  if (!window.google) {
    throw new Error(t("sync.errors.googleIdentityUnavailable"));
  }
  const client = getTokenClient(clientId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      currentResolve = null;
      currentReject = null;
      reject(new Error(t("sync.errors.connectionTimedOut")));
    }, TOKEN_REQUEST_TIMEOUT_MS);

    currentResolve = (token) => {
      clearTimeout(timeout);
      resolve(token);
    };
    currentReject = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
    client.requestAccessToken();
  });
}

async function findFileId(accessToken: string, filename: string): Promise<string | null> {
  const query = encodeURIComponent(`name = '${filename.replace(/'/g, "\\'")}' and trashed = false`);
  const response = await fetch(`${DRIVE_FILES_URL}?q=${query}&spaces=drive&fields=files(id)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(t("sync.errors.listFilesFailed"));
  }
  const data = await response.json();
  return data.files?.[0]?.id ?? null;
}

// Scope drive.file : l'app ne voit et ne modifie que les fichiers qu'elle a
// elle-même créés sur le Drive de l'utilisateur, jamais l'ensemble du Drive.
export async function uploadToGoogleDrive(
  accessToken: string,
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  const existingId = await findFileId(accessToken, filename);
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/x-sqlite3" });

  if (existingId) {
    const response = await fetch(`${DRIVE_UPLOAD_URL}/${existingId}?uploadType=media`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/x-sqlite3" },
      body: blob,
    });
    if (!response.ok) {
      throw new Error(t("sync.errors.updateFileFailed"));
    }
    return;
  }

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: filename })], { type: "application/json" }));
  form.append("file", blob);

  const response = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(t("sync.errors.uploadFileFailed"));
  }
}
