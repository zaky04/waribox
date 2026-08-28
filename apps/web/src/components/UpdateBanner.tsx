import { useEffect } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { useTranslation } from "react-i18next";
import { isTauriRuntime } from "../features/settings/tauriRuntime";

export function UpdateBanner() {
  const { t } = useTranslation();
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW();

  // Sur Tauri (desktop et Android), installer une mise à jour de l'app est
  // déjà un redémarrage à froid du processus natif (nouvel exécutable/APK
  // installé, ancien processus fermé) — aucune "vente en cours" ne peut
  // survivre à ça, contrairement à un onglet PWA resté ouvert en continu.
  // Avec le mode "prompt" ci-dessous (choisi pour la PWA), le nouveau
  // service worker ne prend le contrôle qu'après un clic explicite sur
  // cette bannière — sur Tauri, personne ne la voit jamais (l'app est
  // relancée en plein écran, pas dans un onglet de navigateur), donc l'app
  // restait bloquée sur l'ancien JavaScript malgré un exécutable/APK à jour
  // (vu en pratique : le bug Android "BaseDirectory.Download" persistait
  // après un relance complète de l'app, et l'affichage de version n'était
  // pas visible après une mise à jour desktop pourtant bien installée —
  // voir journal CLAUDE.md). On adopte donc la mise à jour immédiatement
  // sur Tauri, sans attendre d'interaction.
  useEffect(() => {
    if (needRefresh && isTauriRuntime()) {
      updateServiceWorker(true);
    }
  }, [needRefresh, updateServiceWorker]);

  if (!needRefresh || isTauriRuntime()) return null;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 16,
        padding: "10px 24px",
        background: "var(--color-bg-elevated)",
        borderBottom: "1px solid var(--color-border)",
        color: "var(--color-text)",
      }}
    >
      <span>{t("updateBanner.message")}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          onClick={() => updateServiceWorker(true)}
          style={{
            padding: "6px 14px",
            borderRadius: "var(--radius-md)",
            border: "none",
            background: "var(--gradient-accent)",
            color: "#0f172a",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {t("updateBanner.update")}
        </button>
        <button
          onClick={() => setNeedRefresh(false)}
          style={{ background: "transparent", border: "none", color: "var(--color-text-muted)", cursor: "pointer" }}
        >
          {t("updateBanner.later")}
        </button>
      </div>
    </div>
  );
}
