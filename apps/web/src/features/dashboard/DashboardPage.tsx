import {
  deriveOrderStatus,
  getLowStockProducts,
  getSalesSummary,
  getSettings,
  hasPermission,
  isBackupDue,
  isCreditOverdue,
  listBackups,
  listCustomerCredits,
  listExpiringBatches,
  listServiceOrders,
  listStores,
  type ExpiringBatch,
  type LowStockEntry,
} from "@gestion-boutique/core";
import { schema, type Database } from "@gestion-boutique/database";
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { badgeStyle, inputStyle, pageStyle } from "../../components/sharedStyles";
import { useAuth } from "../auth/useAuth";

type ServiceOrder = typeof schema.serviceOrders.$inferSelect;
type Credit = typeof schema.customerCredits.$inferSelect;

function todayRange() {
  const today = new Date().toISOString().slice(0, 10);
  return { from: today, to: today };
}

// Même fenêtre que StockPage.tsx (bannière "Péremptions proches") — les deux
// doivent rester cohérents.
const EXPIRY_WARNING_DAYS = 14;

async function countReadyServiceOrders(db: Database, orders: ServiceOrder[]): Promise<number> {
  const openOrders = orders.filter((o) => !o.closedAt);
  if (openOrders.length === 0) return 0;

  const allItems = await db.select().from(schema.serviceOrderItems);
  const itemsByOrder = new Map<number, typeof allItems>();
  for (const item of allItems) {
    const list = itemsByOrder.get(item.serviceOrderId) ?? [];
    list.push(item);
    itemsByOrder.set(item.serviceOrderId, list);
  }

  return openOrders.filter((order) => {
    const items = itemsByOrder.get(order.id) ?? [];
    return deriveOrderStatus(items).status === "ready";
  }).length;
}

// Chaque carte KPI a sa propre teinte d'accent (icône + halo) pour repérer
// l'indicateur d'un coup d'œil, plutôt qu'une grille de cartes identiques.
function KpiCard({
  icon,
  iconColor,
  title,
  value,
  children,
}: {
  icon: string;
  iconColor: string;
  title: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  const cardWithGlow: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    background: "var(--color-bg-elevated)",
    padding: 24,
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--color-border)",
    boxShadow: "var(--shadow-card)",
    position: "relative",
    overflow: "hidden",
  };

  return (
    <div style={cardWithGlow}>
      <div
        style={{
          position: "absolute",
          top: -30,
          right: -30,
          width: 100,
          height: 100,
          borderRadius: "50%",
          background: iconColor,
          opacity: 0.12,
        }}
      />
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: "var(--radius-md)",
          background: iconColor,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
        }}
      >
        {icon}
      </div>
      <strong style={{ color: "var(--color-text-muted)", fontSize: 14, fontWeight: 600 }}>{title}</strong>
      <div style={{ fontSize: 32, fontWeight: 800 }}>{value}</div>
      {children}
    </div>
  );
}

export function DashboardPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const { t } = useTranslation();

  const canViewReports = hasPermission(user?.permissions ?? {}, "view_reports");
  const canViewStock = hasPermission(user?.permissions ?? {}, "manage_stock");
  const canViewServiceOrders = hasPermission(user?.permissions ?? {}, "manage_service_orders");
  const canViewCredits = hasPermission(user?.permissions ?? {}, "manage_credits");
  const canViewOwnSales = hasPermission(user?.permissions ?? {}, "manage_sales");
  const canSwitchStore = hasPermission(user?.permissions ?? {}, "switch_store");
  // Aligné sur qui peut effectivement agir sur les sauvegardes (Paramètres →
  // Sauvegardes est déjà réservé à manage_settings) — pas d'intérêt à
  // afficher cet indicateur à un rôle qui ne peut de toute façon rien y faire.
  const canManageBackups = hasPermission(user?.permissions ?? {}, "manage_settings");

  const [todayRevenue, setTodayRevenue] = useState(0);
  const [todaySaleCount, setTodaySaleCount] = useState(0);
  const [myTodayRevenue, setMyTodayRevenue] = useState(0);
  const [myTodaySaleCount, setMyTodaySaleCount] = useState(0);
  const [lowStock, setLowStock] = useState<LowStockEntry[]>([]);
  const [expiringBatches, setExpiringBatches] = useState<ExpiringBatch[]>([]);
  const [readyOrderCount, setReadyOrderCount] = useState(0);
  const [overdueCredits, setOverdueCredits] = useState<Credit[]>([]);
  const [backupOverdue, setBackupOverdue] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);

  const [stores, setStores] = useState<Awaited<ReturnType<typeof listStores>>>([]);
  const [multiStoreEnabled, setMultiStoreEnabled] = useState(false);
  // Vide = "Toutes les boutiques" (agrégé) — voir ReportsPage, même logique.
  const [dashboardStoreFilter, setDashboardStoreFilter] = useState("");

  useEffect(() => {
    (async () => {
      const [storeRows, settings] = await Promise.all([listStores(db), getSettings(db)]);
      setStores(storeRows);
      setMultiStoreEnabled(settings.multiStoreEnabled);
    })();
  }, [db]);

  const effectiveStoreId = canSwitchStore
    ? dashboardStoreFilter === ""
      ? undefined
      : Number(dashboardStoreFilter)
    : (currentStoreId ?? undefined);

  const refresh = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const storeId = effectiveStoreId;

    if (canViewReports) {
      const summary = await getSalesSummary(db, todayRange(), storeId);
      setTodayRevenue(summary.totalRevenue);
      setTodaySaleCount(summary.saleCount);
    }
    if (canViewOwnSales && user) {
      const mine = await getSalesSummary(db, todayRange(), storeId, user.id);
      setMyTodayRevenue(mine.totalRevenue);
      setMyTodaySaleCount(mine.saleCount);
    }
    if (canViewStock) {
      setLowStock(await getLowStockProducts(db, storeId));
      setExpiringBatches(await listExpiringBatches(db, EXPIRY_WARNING_DAYS, storeId));
    }
    if (canViewServiceOrders) {
      const orders = await listServiceOrders(db, { storeId });
      setReadyOrderCount(await countReadyServiceOrders(db, orders));
    }
    if (canViewCredits) {
      const credits = await listCustomerCredits(db, storeId);
      setOverdueCredits(credits.filter((c) => isCreditOverdue(c, today)));
    }
    if (canManageBackups) {
      const [backups, settings] = await Promise.all([listBackups(db), getSettings(db)]);
      // La plus récente réussie, tous destinations confondues (dossier local
      // ou Google Drive) — l'une ou l'autre suffit à protéger les données.
      const lastSuccess = backups.find((b) => b.status === "success");
      setLastBackupAt(lastSuccess?.createdAt ?? null);
      setBackupOverdue(isBackupDue(lastSuccess?.createdAt ?? null, settings.backupFrequency));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    db,
    canViewReports,
    canViewOwnSales,
    canViewStock,
    canViewServiceOrders,
    canViewCredits,
    canManageBackups,
    user,
    effectiveStoreId,
  ]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1>{t("dashboard.title")}</h1>
        {canSwitchStore && multiStoreEnabled && stores.filter((s) => s.isActive).length > 1 && (
          <label>
            {t("dashboard.store")}
            <select
              style={{ ...inputStyle, marginTop: 0 }}
              value={dashboardStoreFilter}
              onChange={(e) => setDashboardStoreFilter(e.target.value)}
            >
              <option value="">{t("dashboard.allStores")}</option>
              {stores
                .filter((s) => s.isActive)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 20,
          marginTop: 24,
        }}
      >
        {canViewReports && (
          <KpiCard icon="💰" iconColor="#0ea5e9" title={t("dashboard.todaySales")} value={todayRevenue.toFixed(0)}>
            <span style={{ color: "var(--color-text-muted)" }}>
              {t("dashboard.saleCount", { count: todaySaleCount })}
            </span>
          </KpiCard>
        )}

        {canViewOwnSales && (
          <KpiCard
            icon="🧾"
            iconColor="#22c55e"
            title={t("dashboard.mySalesToday")}
            value={myTodayRevenue.toFixed(0)}
          >
            <span style={{ color: "var(--color-text-muted)" }}>
              {t("dashboard.mySaleCount", { count: myTodaySaleCount })}
            </span>
          </KpiCard>
        )}

        {canViewStock && (
          <KpiCard icon="📦" iconColor="#f59e0b" title={t("dashboard.lowStock")} value={lowStock.length}>
            <span style={badgeStyle(lowStock.length > 0 ? "warning" : "ok")}>
              {lowStock.length > 0 ? t("dashboard.lowStockWarning") : t("dashboard.lowStockOk")}
            </span>
          </KpiCard>
        )}

        {canViewStock && (
          <KpiCard
            icon="⏳"
            iconColor="#f97316"
            title={t("dashboard.expiringSoon", { days: EXPIRY_WARNING_DAYS })}
            value={expiringBatches.length}
          >
            <span style={badgeStyle(expiringBatches.length > 0 ? "warning" : "ok")}>
              {expiringBatches.length > 0 ? t("dashboard.expiringWarning") : t("dashboard.expiringNone")}
            </span>
          </KpiCard>
        )}

        {canViewServiceOrders && (
          <KpiCard icon="🧺" iconColor="#818cf8" title={t("dashboard.readyOrders")} value={readyOrderCount} />
        )}

        {canViewCredits && (
          <KpiCard icon="💳" iconColor="#f43f5e" title={t("dashboard.overdueCredits")} value={overdueCredits.length}>
            <span style={badgeStyle(overdueCredits.length > 0 ? "warning" : "ok")}>
              {overdueCredits.length > 0 ? t("dashboard.overdueCreditsWarning") : t("dashboard.overdueCreditsNone")}
            </span>
          </KpiCard>
        )}

        {canManageBackups && (
          <KpiCard
            icon="🛡️"
            iconColor="#64748b"
            title={t("dashboard.backup")}
            value={lastBackupAt ? lastBackupAt.slice(0, 10) : t("dashboard.backupNever")}
          >
            <span style={badgeStyle(backupOverdue ? "warning" : "ok")}>
              {backupOverdue ? t("dashboard.backupOverdue") : t("dashboard.backupUpToDate")}
            </span>
          </KpiCard>
        )}
      </div>
    </main>
  );
}
