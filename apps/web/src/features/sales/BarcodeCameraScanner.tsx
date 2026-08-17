import { BrowserMultiFormatReader } from "@zxing/browser";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// Détecte si un scan par caméra est possible sur cet appareil/navigateur —
// utilisé pour n'afficher le bouton "Scanner (caméra)" que là où il a une
// chance de fonctionner (getUserMedia exige un contexte sécurisé : HTTPS ou
// localhost/Tauri). Volontairement permissif : même sans la caméra native
// BarcodeDetector, @zxing/browser sait décoder depuis un flux vidéo.
export function isCameraScanSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

// Formats attendus pour des codes-barres produits (voir ensureVariantBarcode,
// qui génère de l'EAN-13) — élargi aux formats courants du commerce de détail
// pour couvrir aussi les codes déjà présents sur les emballages fournisseurs.
const BARCODE_DETECTOR_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"];

interface BarcodeCameraScannerProps {
  onDetected: (code: string) => void;
  onClose: () => void;
}

// Utilise l'API native BarcodeDetector quand disponible (Chrome/WebView
// Android — pas de dépendance, décodage très rapide) ; sinon bascule sur
// @zxing/browser, qui gère lui-même l'accès caméra et le décodage en JS pur,
// pour couvrir les navigateurs qui n'exposent pas BarcodeDetector (Firefox,
// Safari desktop...).
export function BarcodeCameraScanner({ onDetected, onClose }: BarcodeCameraScannerProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let rafId: number | null = null;
    let zxingControls: { stop: () => void } | null = null;

    async function start() {
      const video = videoRef.current;
      if (!video) return;

      const hasBarcodeDetector = "BarcodeDetector" in window;

      try {
        if (hasBarcodeDetector) {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          video.srcObject = stream;
          await video.play();

          // @ts-expect-error BarcodeDetector n'est pas encore dans les types TS standard
          const detector = new window.BarcodeDetector({ formats: BARCODE_DETECTOR_FORMATS });
          const tick = async () => {
            if (cancelled) return;
            try {
              const results = await detector.detect(video);
              if (results.length > 0 && results[0].rawValue) {
                onDetectedRef.current(results[0].rawValue);
                return;
              }
            } catch {
              // frame illisible — on retente à la prochaine, pas une erreur fatale
            }
            rafId = requestAnimationFrame(tick);
          };
          rafId = requestAnimationFrame(tick);
        } else {
          const reader = new BrowserMultiFormatReader();
          const controls = await reader.decodeFromVideoDevice(undefined, video, (result, err) => {
            if (cancelled) return;
            if (result) onDetectedRef.current(result.getText());
            // `err` (NotFoundException) est émis en continu tant qu'aucun code
            // n'est dans le champ — ce n'est pas une erreur à afficher.
          });
          zxingControls = controls;
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error && err.name === "NotAllowedError"
              ? t("sales.scanner.permissionDenied")
              : t("sales.scanner.accessFailed"),
          );
        }
      }
    }

    start();

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (zxingControls) zxingControls.stop();
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.85)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div style={{ position: "relative", width: "100%", maxWidth: 480 }}>
        <video
          ref={videoRef}
          style={{ width: "100%", borderRadius: 12, background: "#000" }}
          muted
          playsInline
        />
        <div
          style={{
            position: "absolute",
            inset: "20% 10%",
            border: "3px solid #4ade80",
            borderRadius: 8,
            pointerEvents: "none",
          }}
        />
      </div>
      {error && (
        <p style={{ color: "#f87171", marginTop: 16, textAlign: "center", maxWidth: 400 }}>{error}</p>
      )}
      {!error && (
        <p style={{ color: "#e2e8f0", marginTop: 16, textAlign: "center" }}>{t("sales.scanner.instructions")}</p>
      )}
      <button
        onClick={onClose}
        style={{
          marginTop: 16,
          padding: "10px 24px",
          borderRadius: 8,
          border: "1px solid #475569",
          background: "transparent",
          color: "#e2e8f0",
          cursor: "pointer",
          fontSize: 14,
        }}
      >
        {t("sales.scanner.close")}
      </button>
    </div>
  );
}
