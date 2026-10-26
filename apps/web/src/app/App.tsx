import { ApprovalProvider } from "../features/approval/ApprovalProvider";
import { getSettings, listStores } from "@gestion-boutique/core";
import { i18next, setCurrency } from "@gestion-boutique/i18n";
import { schema } from "@gestion-boutique/database";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { UpdateBanner } from "../components/UpdateBanner";
import { applyAppearance } from "../lib/appearance";
import { useLanguageStore } from "../stores/language";
import { useThemeStore } from "../stores/theme";
import { BusinessHeader } from "./BusinessHeader";
import { AuthGate } from "../features/auth/AuthGate";
import { NetworkProvider } from "../features/network/NetworkProvider";
import { TopBar } from "../features/auth/TopBar";
import { useAuth } from "../features/auth/useAuth";
import { useIdleLock } from "../features/auth/useIdleLock";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { useBackupScheduler } from "../features/settings/useBackupScheduler";
import { useFneQueue } from "../features/fne/useFneQueue";
import { DatabaseProvider, useDatabase } from "./DatabaseProvider";
import { Nav, type ModuleTab, type NavTab } from "./Nav";

// Chaque page est chargée à la demande : le premier affichage n'embarque plus
// tout le code de l'application (2,3 Mo d'un seul bloc), ce qui compte sur un
// téléphone d'entrée de gamme. Hors ligne rien ne change : le service worker
// met tous les morceaux en cache à l'installation.
const InventoryPage = lazy(() => import("../features/inventory/InventoryPage").then((m) => ({ default: m.InventoryPage })));
const ApprovalsPage = lazy(() => import("../features/approval/ApprovalsPage").then((m) => ({ default: m.ApprovalsPage })));
const ControlsPage = lazy(() => import("../features/controls/ControlsPage").then((m) => ({ default: m.ControlsPage })));
const AccountingPage = lazy(() => import("../features/accounting/AccountingPage").then((m) => ({ default: m.AccountingPage })));
const CreditsPage = lazy(() => import("../features/credits/CreditsPage").then((m) => ({ default: m.CreditsPage })));
const CustomersPage = lazy(() => import("../features/customers/CustomersPage").then((m) => ({ default: m.CustomersPage })));
const DebtsPage = lazy(() => import("../features/debts/DebtsPage").then((m) => ({ default: m.DebtsPage })));
const ExpensesPage = lazy(() => import("../features/expenses/ExpensesPage").then((m) => ({ default: m.ExpensesPage })));
const JournalsPage = lazy(() => import("../features/journals/JournalsPage").then((m) => ({ default: m.JournalsPage })));
const ProductsPage = lazy(() => import("../features/products/ProductsPage").then((m) => ({ default: m.ProductsPage })));
const PromotionsPage = lazy(() => import("../features/promotions/PromotionsPage").then((m) => ({ default: m.PromotionsPage })));
const PurchasesPage = lazy(() => import("../features/purchases/PurchasesPage").then((m) => ({ default: m.PurchasesPage })));
const QuotesPage = lazy(() => import("../features/quotes/QuotesPage").then((m) => ({ default: m.QuotesPage })));
const ReportsPage = lazy(() => import("../features/reports/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const SalesHistoryPage = lazy(() => import("../features/sales/SalesHistoryPage").then((m) => ({ default: m.SalesHistoryPage })));
const SalesPage = lazy(() => import("../features/sales/SalesPage").then((m) => ({ default: m.SalesPage })));
const ServiceOrdersPage = lazy(() => import("../features/serviceOrders/ServiceOrdersPage").then((m) => ({ default: m.ServiceOrdersPage })));
const SettingsPage = lazy(() => import("../features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const StockPage = lazy(() => import("../features/stock/StockPage").then((m) => ({ default: m.StockPage })));
const SuppliersPage = lazy(() => import("../features/suppliers/SuppliersPage").then((m) => ({ default: m.SuppliersPage })));
const UsersPage = lazy(() => import("../features/users/UsersPage").then((m) => ({ default: m.UsersPage })));

type Store = typeof schema.stores.$inferSelect;

const DEFAULT_ENABLED_MODULES: Record<ModuleTab, boolean> = {
  sales: true,
  products: true,
  stock: true,
  suppliers: true,
  purchases: true,
  service_orders: false,
  promotions: false,
};

function MainContent() {
  const { t } = useTranslation();
  const db = useDatabase();
  const { user } = useAuth();
  const [tab, setTab] = useState<NavTab>("dashboard");
  const [businessName, setBusinessName] = useState<string | null>(null);
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [enabledModules, setEnabledModules] = useState<Record<ModuleTab, boolean>>(DEFAULT_ENABLED_MODULES);
  const [autoLockMinutes, setAutoLockMinutes] = useState(0);
  const [multiStoreEnabled, setMultiStoreEnabled] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [sectorType, setSectorType] = useState<string | null>(null);
  const [appearanceAccentColor, setAppearanceAccentColor] = useState<string | null>(null);
  const [appearanceShape, setAppearanceShape] = useState<string | null>(null);
  const [appearanceBackground, setAppearanceBackground] = useState<string | null>(null);
  const [appearanceFont, setAppearanceFont] = useState<string | null>(null);
  const theme = useThemeStore((s) => s.theme);
  const headerRef = useRef<HTMLDivElement>(null);
  useBackupScheduler();
  useFneQueue(db);
  useIdleLock(autoLockMinutes);

  // Repart sur Accueil à chaque changement d'identité (connexion normale,
  // impersonation par un Admin, retour à son propre compte) — évite de
  // rester bloqué sur un onglet que le nouveau compte n'a plus le droit de
  // voir (ex: Utilisateurs après avoir basculé sur un compte Vendeur).
  useEffect(() => {
    setTab("dashboard");
  }, [user?.id]);

  // Un seul getSettings() par changement d'onglet, partagé par le bandeau
  // d'en-tête, la Nav et le sélecteur de boutique (au lieu de plusieurs
  // lectures séparées) — c'est ce qui permet à ces trois-là de refléter un
  // changement de Paramètres dès qu'on change d'onglet, sans attendre un
  // verrouillage/déverrouillage ou un rechargement complet de la page.
  useEffect(() => {
    Promise.all([getSettings(db), listStores(db)]).then(([settings, storeRows]) => {
      setCurrency(settings.currency);
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
        promotions: settings.enablePromotions,
      });
      setMultiStoreEnabled(settings.multiStoreEnabled);
      setStores(storeRows);
      setSectorType(settings.sectorType ?? null);
      setAppearanceAccentColor(settings.appearanceAccentColor ?? null);
      setAppearanceShape(settings.appearanceShape ?? null);
      setAppearanceBackground(settings.appearanceBackground ?? null);
      setAppearanceFont(settings.appearanceFont ?? null);
    });
  }, [db, tab]);

  // Hauteur de l'en-tête sticky → --app-header-h, pour que la colonne de
  // menu (≥1024px, voir index.css) se cale juste sous lui même quand il
  // change de hauteur (bandeau d'impersonation, retour à la ligne...).
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const update = () => document.documentElement.style.setProperty("--app-header-h", `${el.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Séparé de l'effet ci-dessus (qui ne tourne qu'au changement d'onglet) :
  // --color-accent-soft/--bg-glow ont une opacité différente en clair/sombre
  // (voir lib/appearance.ts), donc cette application doit aussi se
  // redéclencher quand `theme` change seul, sans attendre un changement
  // d'onglet ni une relecture de business_settings.
  useEffect(() => {
    applyAppearance(
      { accent: appearanceAccentColor, shape: appearanceShape, background: appearanceBackground, font: appearanceFont },
      theme,
    );
  }, [appearanceAccentColor, appearanceShape, appearanceBackground, appearanceFont, theme]);

  return (
    <ApprovalProvider>
      {/* top en env(safe-area-inset-top) et pas 0 : un élément sticky se
          bloque à sa propre valeur `top`, indépendamment du padding-top déjà
          posé sur body (voir index.css) — avec top:0 il repasserait sous la
          barre de statut Android dès le premier défilement. */}
      <div
        ref={headerRef}
        style={{ position: "sticky", top: "env(safe-area-inset-top)", zIndex: 10, background: "var(--color-bg)" }}
      >
        <TopBar multiStoreEnabled={multiStoreEnabled} stores={stores} />
        <BusinessHeader businessName={businessName} logoDataUrl={logoDataUrl} />
        <Nav active={tab} onChange={setTab} enabledModules={enabledModules} sectorType={sectorType} />
      </div>
      <div className="app-body">
        <Nav
          placement="sidebar"
          active={tab}
          onChange={setTab}
          enabledModules={enabledModules}
          sectorType={sectorType}
          businessName={businessName}
          logoDataUrl={logoDataUrl}
        />
        <div className="app-content">
      <ErrorBoundary resetKey={tab}>
      <Suspense fallback={<div style={{ padding: 24 }}>{t("app.pageLoading")}</div>}>
      {tab === "dashboard" && <DashboardPage onNavigate={setTab} />}
      {tab === "sales" && enabledModules.sales && <SalesPage />}
      {tab === "sales_history" && enabledModules.sales && <SalesHistoryPage />}
      {tab === "quotes" && enabledModules.sales && <QuotesPage />}
      {tab === "service_orders" && enabledModules.service_orders && <ServiceOrdersPage />}
      {tab === "promotions" && enabledModules.promotions && <PromotionsPage />}
      {tab === "products" && enabledModules.products && <ProductsPage />}
      {tab === "stock" && enabledModules.stock && <StockPage />}
      {tab === "inventory" && enabledModules.stock && <InventoryPage />}
      {tab === "customers" && <CustomersPage />}
      {tab === "suppliers" && enabledModules.suppliers && <SuppliersPage />}
      {tab === "purchases" && enabledModules.purchases && <PurchasesPage />}
      {tab === "credits" && <CreditsPage />}
      {tab === "debts" && <DebtsPage />}
      {tab === "reports" && <ReportsPage />}
      {tab === "controls" && <ControlsPage />}
      {tab === "approvals" && <ApprovalsPage />}
      {tab === "expenses" && <ExpensesPage />}
      {tab === "accounting" && <AccountingPage />}
      {tab === "settings" && <SettingsPage section="config" />}
      {tab === "advanced" && <SettingsPage section="advanced" />}
      {tab === "appearance" && <SettingsPage section="appearance" />}
      {tab === "users" && <UsersPage />}
      {tab === "journals" && <JournalsPage />}
      </Suspense>
      </ErrorBoundary>
        </div>
      </div>
    </ApprovalProvider>
  );
}

// UpdateBanner (useRegisterSW) doit être monté inconditionnellement, pas
// seulement après connexion — sinon le service worker ne s'enregistre jamais
// tant qu'aucun compte n'est connecté (écran de connexion/setup non couvert).
export function App() {
  // Force le montage de useLanguageStore ici (une seule fois, au niveau
  // racine) pour que setLanguage(langue sauvegardée) tourne avant le premier
  // rendu de tout composant traduit — même schéma que useThemeStore.
  useLanguageStore();

  return (
    <I18nextProvider i18n={i18next}>
      <UpdateBanner />
      <ErrorBoundary>
        <DatabaseProvider>
          <NetworkProvider>
            <AuthGate>
              <MainContent />
            </AuthGate>
          </NetworkProvider>
        </DatabaseProvider>
      </ErrorBoundary>
    </I18nextProvider>
  );
}
