import { isTauriRuntime } from "../features/settings/tauriRuntime";

// window.open() ne fonctionne pas de façon fiable dans la webview Tauri
// (desktop/Android) — il faut passer par le plugin opener, qui délègue au
// navigateur/à l'application système par défaut pour l'URL donnée.
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank");
  }
}
