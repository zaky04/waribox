import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cardStyle, inputStyle } from "./sharedStyles";

export interface FilterBarProps {
  from?: string;
  to?: string;
  onFromChange?: (value: string) => void;
  onToChange?: (value: string) => void;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  onReset?: () => void;
  children?: ReactNode;
}

// Barre de filtre partagée par Journaux (x3 sous-onglets), Stock et Dépenses
// — évite de dupliquer la même carte "dates + recherche + reset" à chaque
// endroit. Les <select> spécifiques à chaque page (utilisateur, type,
// emplacement, catégorie) passent en `children` plutôt que d'être
// génériqués : chacun a une liste d'options différente.
export function FilterBar({
  from,
  to,
  onFromChange,
  onToChange,
  search,
  onSearchChange,
  searchPlaceholder,
  onReset,
  children,
}: FilterBarProps) {
  const { t } = useTranslation();
  return (
    <div style={{ ...cardStyle, flexDirection: "row", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
      {onFromChange && (
        <label>
          {t("common.filterBar.from")}
          <input style={inputStyle} type="date" value={from ?? ""} onChange={(e) => onFromChange(e.target.value)} />
        </label>
      )}
      {onToChange && (
        <label>
          {t("common.filterBar.to")}
          <input style={inputStyle} type="date" value={to ?? ""} onChange={(e) => onToChange(e.target.value)} />
        </label>
      )}
      {children}
      {onSearchChange && (
        <label style={{ flex: 1, minWidth: 200 }}>
          {t("common.filterBar.search")}
          <input
            style={inputStyle}
            value={search ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
          />
        </label>
      )}
      {onReset && (
        <button
          type="button"
          onClick={onReset}
          style={{ ...inputStyle, width: "auto", cursor: "pointer", marginTop: 0 }}
        >
          {t("common.filterBar.reset")}
        </button>
      )}
    </div>
  );
}
