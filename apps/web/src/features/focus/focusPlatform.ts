import type { FocusBackend, FocusEnv } from "@gestion-boutique/core";
import { focusBackend } from "@gestion-boutique/core";
import { isTauri } from "@tauri-apps/api/core";

// Pont natif posé par MainActivity.kt sur Android (voir apps/desktop/android-overrides).
interface WariBoxNativeBridge {
  setImmersive(enabled: boolean): void;
}

function nativeBridge(): WariBoxNativeBridge | undefined {
  return (window as unknown as { WariBoxNative?: WariBoxNativeBridge }).WariBoxNative;
}

export function readFocusEnv(): FocusEnv {
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    window.matchMedia?.("(display-mode: fullscreen)").matches === true ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return {
    isTauri: isTauri(),
    isAndroid: /Android/i.test(navigator.userAgent),
    hasNativeBridge: typeof nativeBridge()?.setImmersive === "function",
    standalone,
    hasFullscreenApi: document.fullscreenEnabled === true,
    // Certains contextes (fenêtre non affichée, WebView exotique) rapportent un écran de 0 px :
    // on se rabat alors sur la fenêtre plutôt que de prendre l'appareil pour un téléphone.
    minScreenSide: Math.min(window.screen.width, window.screen.height) || Math.min(window.innerWidth, window.innerHeight),
  };
}

export function currentBackend(): FocusBackend {
  return focusBackend(readFocusEnv());
}

// Le plein écran actuel, tel que la plateforme le rapporte (null si elle ne sait pas le dire).
export async function readFullscreen(backend: FocusBackend): Promise<boolean | null> {
  switch (backend) {
    case "tauri-window": {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      return getCurrentWindow().isFullscreen();
    }
    case "web-fullscreen":
      return document.fullscreenElement !== null;
    default:
      return null;
  }
}

export async function setFullscreen(backend: FocusBackend, enabled: boolean): Promise<void> {
  switch (backend) {
    case "tauri-window": {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFullscreen(enabled);
      return;
    }
    case "android-native":
      nativeBridge()?.setImmersive(enabled);
      return;
    case "web-fullscreen":
      if (enabled) {
        // Exige un geste de l'utilisateur ; échoue sinon (géré par l'appelant).
        if (document.fullscreenElement === null) await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      } else if (document.fullscreenElement !== null) {
        await document.exitFullscreen();
      }
      return;
    default:
      return;
  }
}
