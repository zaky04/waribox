import { describe, expect, it } from "vitest";
import { focusAutoEnter, focusAvailable, focusBackend, focusExitNeedsCode, type FocusEnv } from "./focusPolicy";

const base: FocusEnv = { isTauri: false, isAndroid: false, hasNativeBridge: false, standalone: false, hasFullscreenApi: true, minScreenSide: 1080 };
const env = (o: Partial<FocusEnv>): FocusEnv => ({ ...base, ...o });

describe("politique du mode focus", () => {
  it("PC (Tauri) : plein écran de la fenêtre, automatique, code exigé pour en sortir", () => {
    const pc = env({ isTauri: true, hasFullscreenApi: false });
    expect(focusBackend(pc)).toBe("tauri-window");
    expect(focusAvailable(pc)).toBe(true);
    expect(focusAutoEnter(pc)).toBe(true);
    expect(focusExitNeedsCode(pc)).toBe(true);
  });

  it("tablette Android (Tauri) avec le pont natif : automatique, code exigé", () => {
    const tablet = env({ isTauri: true, isAndroid: true, hasNativeBridge: true, minScreenSide: 800 });
    expect(focusBackend(tablet)).toBe("android-native");
    expect(focusAutoEnter(tablet)).toBe(true);
    expect(focusExitNeedsCode(tablet)).toBe(true);
  });

  it("Android sans le pont natif (ancien APK) : mode focus indisponible, rien n'est forcé", () => {
    const old = env({ isTauri: true, isAndroid: true, hasNativeBridge: false, minScreenSide: 800 });
    expect(focusBackend(old)).toBe("none");
    expect(focusAvailable(old)).toBe(false);
    expect(focusAutoEnter(old)).toBe(false);
  });

  it("téléphone : pas de mode focus du tout", () => {
    for (const phone of [
      env({ isTauri: true, isAndroid: true, hasNativeBridge: true, minScreenSide: 412 }),
      env({ standalone: true, minScreenSide: 390 }),
    ]) {
      expect(focusAvailable(phone)).toBe(false);
      expect(focusAutoEnter(phone)).toBe(false);
      expect(focusExitNeedsCode(phone)).toBe(false);
    }
  });

  it("PWA installée sur tablette ou PC : plein écran automatique (au premier geste)", () => {
    const pwa = env({ standalone: true, minScreenSide: 768 });
    expect(focusBackend(pwa)).toBe("web-fullscreen");
    expect(focusAutoEnter(pwa)).toBe(true);
  });

  it("simple onglet de navigateur : disponible à la main, jamais forcé", () => {
    const tab = env({});
    expect(focusAvailable(tab)).toBe(true);
    expect(focusAutoEnter(tab)).toBe(false);
  });

  it("navigateur sans API plein écran : indisponible", () => {
    expect(focusAvailable(env({ hasFullscreenApi: false }))).toBe(false);
  });

  it("limite exacte entre téléphone et tablette : 600 px", () => {
    expect(focusAvailable(env({ minScreenSide: 599 }))).toBe(false);
    expect(focusAvailable(env({ minScreenSide: 600 }))).toBe(true);
  });
});
