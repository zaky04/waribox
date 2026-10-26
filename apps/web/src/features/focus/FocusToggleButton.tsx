import { useTranslation } from "react-i18next";
import { IconFullscreen, IconFullscreenExit } from "../../components/icons";
import { useFocus } from "./FocusProvider";

// Entrer / quitter le mode focus. `floating` : petit bouton flottant pour les
// écrans sans barre du haut (connexion, verrouillage). Rien n'est affiché là où
// le mode focus n'existe pas (téléphone, plateforme sans plein écran).
export function FocusToggleButton({ floating = false }: { floating?: boolean }) {
  const { available, active, enter, requestExit } = useFocus();
  const { t } = useTranslation();
  if (!available) return null;

  const label = active ? t("focus.exitButton") : t("focus.enterButton");
  return (
    <button
      type="button"
      onClick={() => void (active ? requestExit() : enter())}
      title={label}
      aria-label={label}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: floating ? "var(--color-bg-side)" : "transparent",
        border: "1px solid var(--color-border)",
        color: "var(--color-text)",
        borderRadius: "var(--radius-md)",
        padding: "6px 12px",
        cursor: "pointer",
        ...(floating ? { position: "fixed", top: "calc(env(safe-area-inset-top) + 10px)", right: 10, zIndex: 900 } : {}),
      }}
    >
      {active ? <IconFullscreenExit size={15} /> : <IconFullscreen size={15} />}
      {!floating && label}
    </button>
  );
}
