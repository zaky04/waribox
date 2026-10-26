import { focusAutoEnter, focusAvailable, focusExitNeedsCode, hasFocusCode, verifyFocusCode, verifyMaintenanceCode } from "@gestion-boutique/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";
import { currentBackend, readFocusEnv, readFullscreen, setFullscreen } from "./focusPlatform";

// Mode focus : plein écran au lancement sur PC et tablette, sortie protégée par
// un code (Configuration → Sécurité). La préférence n'est PAS mémorisée : chaque
// lancement repart en plein écran, c'est le but (garder la personne concentrée
// sur l'appli) ; en sortir est un choix de la session en cours.

interface FocusContextValue {
  available: boolean;
  active: boolean;
  enter: () => Promise<void>;
  requestExit: () => Promise<void>;
}

const FocusContext = createContext<FocusContextValue>({
  available: false,
  active: false,
  enter: async () => {},
  requestExit: async () => {},
});

export function useFocus(): FocusContextValue {
  return useContext(FocusContext);
}

export function FocusProvider({ children }: { children: ReactNode }) {
  const db = useDatabase();
  const env = useMemo(() => readFocusEnv(), []);
  const backend = useMemo(() => currentBackend(), []);
  const available = focusAvailable(env);
  const autoEnter = focusAutoEnter(env);
  const [active, setActive] = useState(false);
  const [askCode, setAskCode] = useState(false);
  // L'utilisateur a quitté le plein écran avec le code : plus de retour automatique ce lancement-ci.
  const optedOut = useRef(false);

  const enter = useCallback(async () => {
    if (!available) return;
    optedOut.current = false;
    try {
      await setFullscreen(backend, true);
      setActive(true);
    } catch {
      // Refusé par la plateforme (pas de geste utilisateur, par exemple) : on réessaie au prochain geste.
    }
  }, [available, backend]);

  const leave = useCallback(async () => {
    optedOut.current = true;
    try {
      await setFullscreen(backend, false);
    } finally {
      setActive(false);
    }
  }, [backend]);

  // Demande de sortie : avec un code défini sur PC/tablette, on le demande ; sinon sortie libre.
  const requestExit = useCallback(async () => {
    if (!active) return;
    if (focusExitNeedsCode(env) && (await hasFocusCode(db))) {
      setAskCode(true);
      return;
    }
    await leave();
  }, [active, db, env, leave]);

  // État initial et lancement : la fenêtre PC démarre déjà en plein écran (tauri.conf.json) ;
  // ailleurs, on entre dès que la plateforme l'autorise.
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void (async () => {
      const current = await readFullscreen(backend).catch(() => null);
      if (cancelled) return;
      if (current === true) {
        setActive(true);
      } else if (autoEnter && backend !== "web-fullscreen") {
        // Fenêtre PC ou tablette Android : aucun geste n'est exigé.
        await enter();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [available, autoEnter, backend, enter]);

  // Le navigateur/la PWA exige un geste pour passer en plein écran : on entre au
  // premier toucher, et on y revient au toucher suivant si Échap l'a quitté.
  // Et si la plateforme sort du plein écran sans notre accord (Échap, F11), on le sait.
  useEffect(() => {
    if (!available || backend !== "web-fullscreen") return;
    const onChange = () => setActive(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    const onGesture = () => {
      if (autoEnter && !optedOut.current && document.fullscreenElement === null) void enter();
    };
    document.addEventListener("pointerdown", onGesture, true);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("pointerdown", onGesture, true);
    };
  }, [available, autoEnter, backend, enter]);

  // Android : les barres système peuvent revenir (retour d'une autre appli) — on les recache.
  useEffect(() => {
    if (!available || backend !== "android-native") return;
    const onVisible = () => {
      if (document.visibilityState === "visible" && !optedOut.current) void setFullscreen(backend, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [available, backend]);

  const value = useMemo(() => ({ available, active, enter, requestExit }), [available, active, enter, requestExit]);

  return (
    <FocusContext.Provider value={value}>
      {children}
      {askCode && (
        <FocusExitDialog
          onCancel={() => setAskCode(false)}
          onUnlocked={async () => {
            setAskCode(false);
            await leave();
          }}
        />
      )}
    </FocusContext.Provider>
  );
}

function FocusExitDialog({ onCancel, onUnlocked }: { onCancel: () => void; onUnlocked: () => Promise<void> }) {
  const db = useDatabase();
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [forgotten, setForgotten] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    if (!code || checking) return;
    setChecking(true);
    setError(null);
    try {
      const ok = forgotten ? await verifyMaintenanceCode(db, code.trim()) : await verifyFocusCode(db, code.trim());
      if (!ok) {
        setError(t(forgotten ? "focus.exit.wrongMaintenanceCode" : "focus.exit.wrongCode"));
        setCode("");
        return;
      }
      await onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("focus.exit.wrongCode"));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{ position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 16 }}
      onClick={onCancel}
    >
      <form
        style={{ ...cardStyle, width: "min(380px, 100%)", marginTop: 0 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 style={{ margin: 0 }}>{t("focus.exit.title")}</h2>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13.5 }}>{t(forgotten ? "focus.exit.maintenanceHint" : "focus.exit.hint")}</p>
        <label>
          {t(forgotten ? "focus.exit.maintenanceCode" : "focus.exit.code")}
          <input
            style={inputStyle}
            type="password"
            autoFocus
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        {error && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{error}</p>}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
          <button style={primaryButtonStyle} type="submit" disabled={!code || checking}>
            {t("focus.exit.confirm")}
          </button>
          <button
            type="button"
            onClick={onCancel}
            style={{ background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)", borderRadius: "var(--radius-md)", padding: "12px 18px", cursor: "pointer" }}
          >
            {t("focus.exit.cancel")}
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            setForgotten((v) => !v);
            setCode("");
            setError(null);
          }}
          style={{ marginTop: 10, background: "transparent", border: "none", color: "var(--color-text-muted)", textDecoration: "underline", cursor: "pointer", fontSize: 13, padding: 0 }}
        >
          {t(forgotten ? "focus.exit.useFocusCode" : "focus.exit.forgotten")}
        </button>
      </form>
    </div>
  );
}
