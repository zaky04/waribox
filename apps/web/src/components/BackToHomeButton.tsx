import { useTranslation } from "react-i18next";
import { useNavigation } from "../app/NavigationContext";

// Sortie d'un écran « bloqué » (ouverture de caisse, déverrouillage...) : ramène à l'accueil.
export function BackToHomeButton() {
  const { t } = useTranslation();
  const { goTo } = useNavigation();
  return (
    <button
      type="button"
      onClick={() => goTo("dashboard")}
      style={{ padding: "10px 16px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text)", cursor: "pointer", fontSize: 14 }}
    >
      ← {t("common.backHome")}
    </button>
  );
}
