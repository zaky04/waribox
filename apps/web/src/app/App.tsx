import { getSettings } from "@gestion-boutique/core";
import { useEffect, useState } from "react";
import { UpdateBanner } from "../components/UpdateBanner";
import { BusinessHeader } from "./BusinessHeader";
import { AccountingPage } from "../features/accounting/AccountingPage";
import { AuthGate } from "../features/auth/AuthGate";
import { TopBar } from "../features/auth/TopBar";
import { useAuth } from "../features/auth/useAuth";
import { useIdleLock } from "../features/auth/useIdleLock";
import { CreditsPage } from "../features/credits/CreditsPage";
import { CustomersPage } from "../features/customers/CustomersPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { DebtsPage } from "../features/debts/DebtsPage";
import { ExpensesPage } from "../features/expenses/ExpensesPage";
import { JournalsPage } from "../features/journals/JournalsPage";
import { ProductsPage } from "../features/products/ProductsPage";
import { PurchasesPage } from "../features/purchases/PurchasesPage";
import { QuotesPage } from "../features/quotes/QuotesPage";
import { ReportsPage } from "../features/reports/ReportsPage";
import { SalesPage } from "../features/sales/SalesPage";
import { ServiceOrdersPage } from "../features/serviceOrders/ServiceOrdersPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { useBackupScheduler } from "../features/settings/useBackupScheduler";
import { StockPage } from "../features/stock/StockPage";
import { SuppliersPage } from "../features/suppliers/SuppliersPage";
import { UsersPage } from "../features/users/UsersPage";
import { DatabaseProvider, useDatabase } from "./DatabaseProvider";
import { Nav, type ModuleTab, type NavTab } from "./Nav";

const DEFAULT_ENABLED_MODULES: Record<ModuleTab, boolean> = {
  sales: true,
  products: true,
  stock: true,
  suppliers: true,
  purchases: true,
  service_orders: false,
};

function MainContent() {
  const db = useDatabase();
  const { user } = useAuth();
  const [tab, setTab] = useState<NavTab>("dashboard");
  const [businessName, setBusinessName] = useState<string | null>(null);
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [enabledModules, setEnabledModules] = useState<Record<ModuleTab, boolean>>(DEFAULT_ENABLED_MODULES);
  const [autoLockMinutes, setAutoLockMinutes] = useState(0);
  useBackupScheduler();
  useIdleLock(autoLockMinutes);

  // Repart sur Accueil à chaque changement d'identité (connexion normale,
  // impersonation par un Admin, retour à son propre compte) — évite de
  // rester bloqué sur un onglet que le nouveau compte n'a plus le droit de
  // voir (ex: Utilisateurs après avoir basculé sur un compte Vendeur).
  useEffect(() => {
    setTab("dashboard");
  }, [user?.id]);

  // Un seul getSettings() par changement d'onglet, partagé par le bandeau
  // d'en-tête et la Nav (au lieu de plusieurs lectures séparées).
  useEffect(() => {
    getSettings(db).then((settings) => {
      setBusinessName(settings.businessName ?? null);
      setLogoDataUrl(settings.logoDataUrl ?? null);
      setAutoLockMinutes(settings.autoLockMinutes);
      setEnabledModules({
        sales: settings.enableSales,
        products: settings.enableProducts,
        stock: settings.enableStock,
        suppliers: settings.enableSuppliers,
        purchases: settings.enablePurchases,
        service_orders: settings.enableServiceOrders,
      });
    });
  }, [db, tab]);

  return (
    <>
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "var(--color-bg)" }}>
        <TopBar />
        <BusinessHeader businessName={businessName} logoDataUrl={logoDataUrl} />
        <Nav active={tab} onChange={setTab} enabledModules={enabledModules} />
      </div>
      {tab === "dashboard" && <DashboardPage />}
      {tab === "sales" && enabledModules.sales && <SalesPage />}
      {tab === "quotes" && enabledModules.sales && <QuotesPage />}
      {tab === "service_orders" && enabledModules.service_orders && <ServiceOrdersPage />}
      {tab === "products" && enabledModules.products && <ProductsPage />}
      {tab === "stock" && enabledModules.stock && <StockPage />}
      {tab === "customers" && <CustomersPage />}
      {tab === "suppliers" && enabledModules.suppliers && <SuppliersPage />}
      {tab === "purchases" && enabledModules.purchases && <PurchasesPage />}
      {tab === "credits" && <CreditsPage />}
      {tab === "debts" && <DebtsPage />}
      {tab === "reports" && <ReportsPage />}
      {tab === "expenses" && <ExpensesPage />}
      {tab === "accounting" && <AccountingPage />}
      {tab === "settings" && <SettingsPage />}
      {tab === "users" && <UsersPage />}
      {tab === "journals" && <JournalsPage />}
    </>
  );
}

// UpdateBanner (useRegisterSW) doit être monté inconditionnellement, pas
// seulement après connexion — sinon le service worker ne s'enregistre jamais
// tant qu'aucun compte n'est connecté (écran de connexion/setup non couvert).
export function App() {
  return (
    <>
      <UpdateBanner />
      <DatabaseProvider>
        <AuthGate>
          <MainContent />
        </AuthGate>
      </DatabaseProvider>
    </>
  );
}
