import { hasPermission, type Permission } from "@gestion-boutique/core";
import { useAuth } from "../features/auth/useAuth";

export type NavTab =
  | "dashboard"
  | "sales"
  | "quotes"
  | "service_orders"
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
const TABS: { key: NavTab; label: string; permission: Permission | null; moduleKey?: ModuleTab }[] = [
  { key: "dashboard", label: "Accueil", permission: null },
  { key: "sales", label: "Ventes", permission: "manage_sales" },
  { key: "quotes", label: "Devis", permission: "manage_quotes", moduleKey: "sales" },
  { key: "service_orders", label: "Tickets de service", permission: "manage_service_orders" },
  { key: "products", label: "Produits", permission: "manage_products" },
  { key: "stock", label: "Stock", permission: "manage_stock" },
  { key: "customers", label: "Clients", permission: "manage_customers" },
  { key: "suppliers", label: "Fournisseurs", permission: "manage_suppliers" },
  { key: "purchases", label: "Achats", permission: "manage_suppliers" },
  { key: "credits", label: "Créances", permission: "manage_credits" },
  { key: "debts", label: "Dettes", permission: "manage_debts" },
  { key: "reports", label: "Rapports", permission: "view_reports" },
  { key: "expenses", label: "Dépenses", permission: "manage_expenses" },
  { key: "accounting", label: "Comptabilité", permission: "view_accounting" },
  { key: "settings", label: "Paramètres", permission: "manage_settings" },
  { key: "users", label: "Utilisateurs", permission: "manage_users" },
  { key: "journals", label: "Journaux", permission: "view_audit_logs" },
];

// Onglets rattachés à un module optionnel choisi à l'installation (voir
// ModuleSetupScreen) — Clients/Créances/Dettes/Rapports/Paramètres/
// Utilisateurs/Journaux restent toujours actifs, hors de ce système.
export type ModuleTab = "sales" | "products" | "stock" | "suppliers" | "purchases" | "service_orders";
const MODULE_TABS: ModuleTab[] = ["sales", "products", "stock", "suppliers", "purchases", "service_orders"];

interface NavProps {
  active: NavTab;
  onChange: (tab: NavTab) => void;
  enabledModules: Record<ModuleTab, boolean>;
}

export function Nav({ active, onChange, enabledModules }: NavProps) {
  const { user } = useAuth();
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

  return (
    <nav
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        padding: "8px 24px",
        background: "var(--color-bg)",
        borderBottom: "1px solid var(--color-bg-elevated)",
      }}
    >
      {visibleTabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: "none",
            background: active === tab.key ? "var(--gradient-accent)" : "transparent",
            color: active === tab.key ? "#0f172a" : "var(--color-text)",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
