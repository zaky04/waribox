import {
  deriveOrderStatus,
  getLowStockProducts,
  getSalesSummary,
  getSettings,
  hasPermission,
  listCustomerCredits,
  listExpiringBatches,
  listServiceOrders,
  listStores,
  type ExpiringBatch,
  type LowStockEntry,
} from "@gestion-boutique/core";
import { schema, type Database } from "@gestion-boutique/database";
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
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

  const canViewReports = hasPermission(user?.permissions ?? {}, "view_reports");
  const canViewStock = hasPermission(user?.permissions ?? {}, "manage_stock");
  const canViewServiceOrders = hasPermission(user?.permissions ?? {}, "manage_service_orders");
  const canViewCredits = hasPermission(user?.permissions ?? {}, "manage_credits");
  const canViewOwnSales = hasPermission(user?.permissions ?? {}, "manage_sales");
  const canSwitchStore = hasPermission(user?.permissions ?? {}, "switch_store");

  const [todayRevenue, setTodayRevenue] = useState(0);
  const [todaySaleCount, setTodaySaleCount] = useState(0);
  const [myTodayRevenue, setMyTodayRevenue] = useState(0);
  const [myTodaySaleCount, setMyTodaySaleCount] = useState(0);
  const [lowStock, setLowStock] = useState<LowStockEntry[]>([]);
  const [expiringBatches, setExpiringBatches] = useState<ExpiringBatch[]>([]);
  const [readyOrderCount, setReadyOrderCount] = useState(0);
  const [overdueCredits, setOverdueCredits] = useState<Credit[]>([]);

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
      const orders = await listServiceOrders(db, storeId);
      setReadyOrderCount(await countReadyServiceOrders(db, orders));
    }
    if (canViewCredits) {
      const credits = await listCustomerCredits(db, storeId);
      setOverdueCredits(
        credits.filter((c) => c.status !== "settled" && c.dueDate && c.dueDate < today),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, canViewReports, canViewOwnSales, canViewStock, canViewServiceOrders, canViewCredits, user, effectiveStoreId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Accueil</h1>
        {canSwitchStore && multiStoreEnabled && stores.filter((s) => s.isActive).length > 1 && (
          <label>
            Boutique
            <select
              style={{ ...inputStyle, marginTop: 0 }}
              value={dashboardStoreFilter}
              onChange={(e) => setDashboardStoreFilter(e.target.value)}
            >
              <option value="">Toutes les boutiques</option>
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
          <KpiCard icon="💰" iconColor="#0ea5e9" title="Ventes du jour" value={todayRevenue.toFixed(0)}>
            <span style={{ color: "var(--color-text-muted)" }}>{todaySaleCount} vente(s)</span>
          </KpiCard>
        )}

        {canViewOwnSales && (
          <KpiCard icon="🧾" iconColor="#22c55e" title="Mes ventes aujourd'hui" value={myTodayRevenue.toFixed(0)}>
            <span style={{ color: "var(--color-text-muted)" }}>{myTodaySaleCount} vente(s) par moi</span>
          </KpiCard>
        )}

        {canViewStock && (
          <KpiCard icon="📦" iconColor="#f59e0b" title="Stock bas" value={lowStock.length}>
            <span style={badgeStyle(lowStock.length > 0 ? "warning" : "ok")}>
              {lowStock.length > 0 ? "Produit(s) à réapprovisionner" : "Tout est en ordre"}
            </span>
          </KpiCard>
        )}

        {canViewStock && (
          <KpiCard
            icon="⏳"
            iconColor="#f97316"
            title={`Péremptions proches (≤ ${EXPIRY_WARNING_DAYS} j)`}
            value={expiringBatches.length}
          >
            <span style={badgeStyle(expiringBatches.length > 0 ? "warning" : "ok")}>
              {expiringBatches.length > 0 ? "Lot(s) à écouler ou retirer" : "Aucune"}
            </span>
          </KpiCard>
        )}

        {canViewServiceOrders && (
          <KpiCard icon="🧺" iconColor="#818cf8" title="Tickets prêts à retirer" value={readyOrderCount} />
        )}

        {canViewCredits && (
          <KpiCard icon="💳" iconColor="#f43f5e" title="Créances en retard" value={overdueCredits.length}>
            <span style={badgeStyle(overdueCredits.length > 0 ? "warning" : "ok")}>
              {overdueCredits.length > 0 ? "À relancer" : "Aucune"}
            </span>
          </KpiCard>
        )}
      </div>
    </main>
  );
}
