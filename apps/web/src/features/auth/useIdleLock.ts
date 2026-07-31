import { useEffect, useRef } from "react";
import { useSessionStore } from "../../stores/session";

const ACTIVITY_EVENTS = ["mousemove", "keydown", "click", "scroll", "touchstart"] as const;

// Reverrouille la session (retour à l'écran PIN) après un délai d'inactivité
// réglable dans Paramètres — protège un poste laissé sans surveillance.
// timeoutMinutes <= 0 désactive la fonctionnalité.
export function useIdleLock(timeoutMinutes: number) {
  const user = useSessionStore((s) => s.user);
  const isLocked = useSessionStore((s) => s.isLocked);
  const lock = useSessionStore((s) => s.lock);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!user || isLocked || timeoutMinutes <= 0) return;

    const resetTimer = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(lock, timeoutMinutes * 60_000);
    };

    resetTimer();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, resetTimer);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, resetTimer);
      }
    };
  }, [user, isLocked, timeoutMinutes, lock]);
}
