// Mode focus : l'appli occupe tout l'écran (PC et tablette) pour que la personne
// reste concentrée dessus ; en sortir demande un code (voir FocusCodeService).
// Ce fichier ne contient que la DÉCISION (pure, testée) : comment passer en plein
// écran sur chaque plateforme est dans apps/web/src/features/focus.

export interface FocusEnv {
  isTauri: boolean;
  isAndroid: boolean;
  // Le build Android expose le pont natif (WariBoxNative.setImmersive) : sans lui
  // (ancien APK), le plein écran n'est pas disponible dans ce WebView.
  hasNativeBridge: boolean;
  // Application installée (PWA) : fenêtre autonome, sans barre d'adresse.
  standalone: boolean;
  hasFullscreenApi: boolean;
  // Plus petit côté de l'écran, en pixels CSS (distingue téléphone et tablette).
  minScreenSide: number;
}

export type FocusBackend = "tauri-window" | "android-native" | "web-fullscreen" | "none";

// Un écran dont le petit côté fait au moins 600 px CSS est une tablette ou un PC.
export const TABLET_MIN_SIDE = 600;

export function isPhone(env: FocusEnv): boolean {
  return env.minScreenSide < TABLET_MIN_SIDE;
}

export function focusBackend(env: FocusEnv): FocusBackend {
  if (env.isTauri) {
    if (!env.isAndroid) return "tauri-window";
    return env.hasNativeBridge ? "android-native" : "none";
  }
  return env.hasFullscreenApi ? "web-fullscreen" : "none";
}

// Le mode focus n'existe pas sur téléphone (déjà un petit écran avec ses propres
// gestes système) ni là où la plateforme ne sait pas passer en plein écran.
export function focusAvailable(env: FocusEnv): boolean {
  return focusBackend(env) !== "none" && !isPhone(env);
}

// Plein écran dès le lancement. Un simple onglet de navigateur n'est jamais
// forcé en plein écran (ce serait agaçant pendant le développement ou une démo) ;
// il reste possible de l'activer à la main.
export function focusAutoEnter(env: FocusEnv): boolean {
  if (!focusAvailable(env)) return false;
  const backend = focusBackend(env);
  return backend === "tauri-window" || backend === "android-native" || env.standalone;
}

// Sur PC et tablette, quitter le plein écran demande le code du mode focus.
export function focusExitNeedsCode(env: FocusEnv): boolean {
  return focusAvailable(env);
}
