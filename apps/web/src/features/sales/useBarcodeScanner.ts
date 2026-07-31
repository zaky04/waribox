import { useEffect, useRef } from "react";

interface UseBarcodeScannerOptions {
  onScan: (code: string) => void;
  minLength?: number;
  // Une douchette "tape" ses caractères bien plus vite qu'un humain (souvent
  // < 30ms entre deux frappes). Au-delà de ce seuil, on considère qu'il ne
  // s'agit pas d'un scan et on réinitialise le tampon.
  maxIntervalMs?: number;
  enabled?: boolean;
}

export function useBarcodeScanner({
  onScan,
  minLength = 3,
  maxIntervalMs = 50,
  enabled = true,
}: UseBarcodeScannerOptions) {
  const bufferRef = useRef("");
  const lastTimeRef = useRef(0);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      const now = Date.now();
      const elapsed = now - lastTimeRef.current;
      const continuingFastSequence = elapsed <= maxIntervalMs;
      lastTimeRef.current = now;

      if (!continuingFastSequence) {
        bufferRef.current = "";
      }

      if (e.key === "Enter") {
        const isValidScan = bufferRef.current.length >= minLength;
        if (isValidScan) {
          // Empêche le code scanné de finir "tapé" dans un champ qui aurait
          // le focus (recherche, nom du client...) et bloque la soumission
          // accidentelle d'un formulaire via cet Entrée.
          e.preventDefault();
          onScanRef.current(bufferRef.current);
        }
        bufferRef.current = "";
        return;
      }

      if (e.key.length === 1) {
        // Dès la 2e frappe d'une rafale rapide, on est quasi certain qu'il
        // s'agit d'une douchette (un humain ne tape jamais à <50ms/touche) :
        // on empêche ces caractères de polluer un champ resté focus.
        if (continuingFastSequence) {
          e.preventDefault();
        }
        bufferRef.current += e.key;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, minLength, maxIntervalMs]);
}
