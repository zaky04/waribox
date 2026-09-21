import { hasPermission, type Permission } from "@gestion-boutique/core";
import { useState, type ComponentType, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../features/auth/useAuth";
import {
  IconBag,
  IconBarChart,
  IconBox,
  IconCalculator,
  IconCart,
  IconClock,
  IconCoins,
  IconCreditCard,
  IconDashboard,
  IconFileText,
  IconHanger,
  IconIdCard,
  IconLayers,
  IconList,
  IconMenu,
  IconPercent,
  IconPill,
  IconSettings,
  IconTicket,
  IconTruck,
  IconUsers,
  IconUtensils,
  IconWallet,
  type IconProps,
} from "../components/icons";
import { isSectorType } from "../features/settings/sectorTypes";

export type NavTab =
  | "dashboard"
  | "sales"
  | "sales_history"
  | "quotes"
  | "service_orders"
  | "promotions"
  | "products"
  | "stock"
  | "customers"
  | "suppliers"
  | "purchases"
  | "credits"
  | "debts"
  | "reports"
  | "expenses"
  | "accounting"
  | "settings"
  | "users"
  | "journals";

// Regroupement purement visuel (menu déroulant mobile, voir plus bas) — ne
// touche à aucune logique de permission/module, seulement à la présentation.
type NavGroup = "sales" | "relations" | "finance" | "system";

// permission: null — onglet toujours visible, indépendant du rôle (comme un
// écran d'accueil universel). moduleKey — rattache l'onglet au module d'un
// autre onglet quand il n'a pas son propre interrupteur dans Paramètres
// (Devis partage le module Ventes).
// label vient de la traduction (clé `nav.<key>`, voir packages/i18n) — pas
// stocké ici pour ne jamais désynchroniser les deux. "dashboard"/"reports"
// restent hors groupe (accueil isolé, rapports rattachés au bloc Finances
// ci-dessous plutôt qu'un groupe à eux seuls).
const TABS: { key: NavTab; permission: Permission | null; moduleKey?: ModuleTab; icon: ComponentType<IconProps>; group?: NavGroup }[] = [
  { key: "dashboard", permission: null, icon: IconDashboard },
  { key: "sales", permission: "manage_sales", icon: IconCart, group: "sales" },
  { key: "sales_history", permission: "view_reports", moduleKey: "sales", icon: IconClock, group: "sales" },
  { key: "quotes", permission: "manage_quotes", moduleKey: "sales", icon: IconFileText, group: "sales" },
  { key: "service_orders", permission: "manage_service_orders", icon: IconTicket, group: "sales" },
  { key: "promotions", permission: "manage_promotions", icon: IconPercent, group: "sales" },
  { key: "products", permission: "manage_products", icon: IconBox, group: "sales" },
  { key: "stock", permission: "manage_stock", icon: IconLayers, group: "sales" },
  { key: "customers", permission: "manage_customers", icon: IconUsers, group: "relations" },
  { key: "suppliers", permission: "manage_suppliers", icon: IconTruck, group: "relations" },
  { key: "purchases", permission: "manage_suppliers", icon: IconBag, group: "relations" },
  { key: "credits", permission: "manage_credits", icon: IconCoins, group: "finance" },
  { key: "debts", permission: "manage_debts", icon: IconCreditCard, group: "finance" },
  { key: "expenses", permission: "manage_expenses", icon: IconWallet, group: "finance" },
  { key: "accounting", permission: "view_accounting", icon: IconCalculator, group: "finance" },
  { key: "reports", permission: "view_reports", icon: IconBarChart, group: "finance" },
  { key: "settings", permission: "manage_settings", icon: IconSettings, group: "system" },
  { key: "users", permission: "manage_users", icon: IconIdCard, group: "system" },
  { key: "journals", permission: "view_audit_logs", icon: IconList, group: "system" },
];

// L'onglet "Produits" adapte son icône et son libellé au secteur d'activité
// choisi dans Paramètres (voir index.css pour l'accent couleur, même idée
// appliquée ici à ce seul onglet) — reprend directement la piste explorée
// dans la maquette de concept (panneau "Top produits"). Boutique et "aucun
// secteur choisi" gardent le libellé/icône par défaut (IconBox, nav.products).
const PRODUCTS_TAB_OVERRIDE: Partial<Record<string, { icon: ComponentType<IconProps>; labelKey: string }>> = {
  pharmacie: { icon: IconPill, labelKey: "nav.productsPharmacie" },
  restaurant: { icon: IconUtensils, labelKey: "nav.productsRestaurant" },
  pressing: { icon: IconHanger, labelKey: "nav.productsPressing" },
};

// Onglets rattachés à un module optionnel choisi à l'installation (voir
// ModuleSetupScreen) — Clients/Créances/Dettes/Rapports/Paramètres/
// Utilisateurs/Journaux restent toujours actifs, hors de ce système.
export type ModuleTab =
  | "sales"
  | "products"
  | "stock"
  | "suppliers"
  | "purchases"
  | "service_orders"
  | "promotions";
const MODULE_TABS: ModuleTab[] = [
  "sales",
  "products",
  "stock",
  "suppliers",
  "purchases",
  "service_orders",
  "promotions",
];

interface NavProps {
  active: NavTab;
  onChange: (tab: NavTab) => void;
  enabledModules: Record<ModuleTab, boolean>;
  sectorType: string | null;
}

export function Nav({ active, onChange, enabledModules, sectorType }: NavProps) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  if (!user) return null;

  const visibleTabs = TABS.filter((tab) => {
    if (tab.permission && !hasPermission(user.permissions, tab.permission)) return false;
    const moduleKey = tab.moduleKey ?? (tab.key as ModuleTab);
    if ((MODULE_TABS as readonly string[]).includes(moduleKey)) {
      return enabledModules[moduleKey];
    }
    return true;
  });
  if (visibleTabs.length === 0) return null;

  const productsOverride = isSectorType(sectorType) ? PRODUCTS_TAB_OVERRIDE[sectorType] : undefined;

  const resolveIcon = (tab: (typeof visibleTabs)[number]): ComponentType<IconProps> =>
    tab.key === "products" && productsOverride ? productsOverride.icon : tab.icon;

  const resolveLabel = (tab: (typeof visibleTabs)[number]): string =>
    tab.key === "products" && productsOverride ? t(productsOverride.labelKey) : t(`nav.${tab.key}`);

  const tabButtonStyle = (tab: (typeof visibleTabs)[number]): CSSProperties => ({
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 16px",
    borderRadius: 8,
    border: "none",
    background: active === tab.key ? "var(--gradient-accent)" : "transparent",
    color: active === tab.key ? "#0f172a" : "var(--color-text)",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    textAlign: "left",
  });

  const activeTab = visibleTabs.find((tab) => tab.key === active) ?? visibleTabs[0]!;
  const ActiveIcon = resolveIcon(activeTab);

  // Regroupe les onglets visibles par `group` (voir TABS) pour insérer un
  // intitulé de section dans le menu déroulant mobile — uniquement là (voir
  // index.css/.nav-full pour pourquoi la barre du haut n'en a pas). Un
  // onglet masqué (permission/module) ne casse pas un groupe : la
  // comparaison porte sur le groupe du dernier onglet réellement affiché.
  let lastGroup: NavGroup | undefined;

  return (
    <>
      {/* Bureau/tablette : retour à la ligne automatique, pas de défilement
          horizontal (voir index.css pour le seuil de bascule avec le mode
          téléphone ci-dessous). Pas de séparateurs de groupe ici — une ligne
          qui retourne déjà à la ligne se prête mal à des ruptures de
          section ; le regroupement reste réservé au menu mobile ci-dessous. */}
      <nav
        className="nav-full"
        style={{
          flexWrap: "wrap",
          gap: 8,
          padding: "8px 16px",
          borderBottom: "1px solid var(--color-bg-elevated)",
        }}
      >
        {visibleTabs.map((tab) => {
          const Icon = resolveIcon(tab);
          return (
            <button key={tab.key} onClick={() => onChange(tab.key)} style={tabButtonStyle(tab)}>
              <Icon size={16} />
              {resolveLabel(tab)}
            </button>
          );
        })}
      </nav>

      {/* Mobile : un défilement horizontal de 18-19 onglets n'est pas
          exploitable au comptoir (pas d'indice de "il en reste"), et un
          retour à la ligne automatique prend 5-6 lignes de haut — un bouton
          menu ouvrant la liste complète en dessous couvre les deux cas. */}
      <div className="nav-compact" style={{ position: "relative", padding: "8px 16px", borderBottom: "1px solid var(--color-bg-elevated)" }}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          onBlur={() => setTimeout(() => setMenuOpen(false), 150)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "8px 16px",
            borderRadius: 8,
            border: "1px solid var(--color-border)",
            background: "var(--color-bg-elevated)",
            color: "var(--color-text)",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <IconMenu size={16} />
          <ActiveIcon size={16} />
          <span>{resolveLabel(activeTab)}</span>
        </button>
        {menuOpen && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 16,
              right: 16,
              marginTop: 4,
              display: "flex",
              flexDirection: "column",
              gap: 2,
              maxHeight: "70vh",
              overflowY: "auto",
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              boxShadow: "var(--shadow-card-strong)",
              padding: 6,
              zIndex: 20,
            }}
          >
            {visibleTabs.map((tab) => {
              const showGroupLabel = tab.group && tab.group !== lastGroup;
              lastGroup = tab.group;
              const Icon = resolveIcon(tab);
              return (
                <div key={tab.key}>
                  {showGroupLabel && (
                    <div
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: "var(--color-text-muted)",
                        margin: "10px 12px 4px",
                      }}
                    >
                      {t(`nav.groups.${tab.group}`)}
                    </div>
                  )}
                  <button
                    onMouseDown={() => {
                      onChange(tab.key);
                      setMenuOpen(false);
                    }}
                    style={tabButtonStyle(tab)}
                  >
                    <Icon size={16} />
                    {resolveLabel(tab)}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
