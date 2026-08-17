import { hasPermission, type Permission } from "@gestion-boutique/core";
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../features/auth/useAuth";

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

// permission: null — onglet toujours visible, indépendant du rôle (comme un
// écran d'accueil universel). moduleKey — rattache l'onglet au module d'un
// autre onglet quand il n'a pas son propre interrupteur dans Paramètres
// (Devis partage le module Ventes).
// label vient de la traduction (clé `nav.<key>`, voir packages/i18n) — pas
// stocké ici pour ne jamais désynchroniser les deux.
const TABS: { key: NavTab; permission: Permission | null; moduleKey?: ModuleTab }[] = [
  { key: "dashboard", permission: null },
  { key: "sales", permission: "manage_sales" },
  { key: "sales_history", permission: "view_reports", moduleKey: "sales" },
  { key: "quotes", permission: "manage_quotes", moduleKey: "sales" },
  { key: "service_orders", permission: "manage_service_orders" },
  { key: "promotions", permission: "manage_promotions" },
  { key: "products", permission: "manage_products" },
  { key: "stock", permission: "manage_stock" },
  { key: "customers", permission: "manage_customers" },
  { key: "suppliers", permission: "manage_suppliers" },
  { key: "purchases", permission: "manage_suppliers" },
  { key: "credits", permission: "manage_credits" },
  { key: "debts", permission: "manage_debts" },
  { key: "reports", permission: "view_reports" },
  { key: "expenses", permission: "manage_expenses" },
  { key: "accounting", permission: "view_accounting" },
  { key: "settings", permission: "manage_settings" },
  { key: "users", permission: "manage_users" },
  { key: "journals", permission: "view_audit_logs" },
];

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
}

export function Nav({ active, onChange, enabledModules }: NavProps) {
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

  const tabButtonStyle = (tab: (typeof visibleTabs)[number]): CSSProperties => ({
    flex: "none",
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

  return (
    <>
      {/* Bureau/tablette : ligne défilable horizontalement, voir index.css
          pour l'ombre de bord qui indique qu'il reste des onglets à droite. */}
      <nav
        className="nav-full table-scroll"
        style={{
          flexWrap: "nowrap",
          WebkitOverflowScrolling: "touch",
          gap: 8,
          padding: "8px 16px",
          borderBottom: "1px solid var(--color-bg-elevated)",
        }}
      >
        {visibleTabs.map((tab) => (
          <button key={tab.key} onClick={() => onChange(tab.key)} style={tabButtonStyle(tab)}>
            {t(`nav.${tab.key}`)}
          </button>
        ))}
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
          <span>☰</span>
          <span>{t(`nav.${activeTab.key}`)}</span>
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
            {visibleTabs.map((tab) => (
              <button
                key={tab.key}
                onMouseDown={() => {
                  onChange(tab.key);
                  setMenuOpen(false);
                }}
                style={tabButtonStyle(tab)}
              >
                {t(`nav.${tab.key}`)}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
