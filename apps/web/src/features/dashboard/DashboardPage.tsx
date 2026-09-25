import { formatAmount } from "../../lib/format";
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
  listSalePayments,
  listSales,
  listServiceOrders,
  listStores,
  type ExpiringBatch,
  type LowStockEntry,
} from "@gestion-boutique/core";
import { schema, type Database } from "@gestion-boutique/database";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import type { NavTab } from "../../app/Nav";
import { amountStyle, badgeStyle, inputStyle, pageStyle } from "../../components/sharedStyles";
import { useAuth } from "../auth/useAuth";

type ServiceOrder = typeof schema.serviceOrders.$inferSelect;
type Credit = typeof schema.customerCredits.$inferSelect;
type Sale = typeof schema.sales.$inferSelect;

function dayString(offsetDays: number) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function todayRange() {
  const today = dayString(0);
  return { from: today, to: today };
}

// createdAt est stocké en UTC ("YYYY-MM-DD HH:MM:SS", CURRENT_TIMESTAMP) — on
// l'affiche et on le range par heure dans l'heure locale de l'appareil.
function toLocalDate(createdAt: string) {
  return new Date(createdAt.replace(" ", "T") + "Z");
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

const dottedRow: CSSProperties = { display: "flex", alignItems: "baseline", gap: 8 };
const dottedLeader: CSSProperties = { flexGrow: 1, borderBottom: "2px dotted var(--color-dot)" };
const outlineButton: CSSProperties = {
  flexShrink: 0,
  height: 36,
  padding: "0 16px",
  border: "1px solid var(--color-text)",
  borderRadius: "var(--radius-md)",
  background: "transparent",
  color: "var(--color-text)",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};

interface TodoRow {
  key: string;
  title: string;
  detail: string;
  target: NavTab;
}

export function DashboardPage({ onNavigate }: { onNavigate?: (tab: NavTab) => void }) {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const { t, i18n } = useTranslation();

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
  const [yesterdayRevenue, setYesterdayRevenue] = useState(0);
  const [myTodayRevenue, setMyTodayRevenue] = useState(0);
  const [myTodaySaleCount, setMyTodaySaleCount] = useState(0);
  const [todaySales, setTodaySales] = useState<Sale[]>([]);
  const [paymentMethodBySale, setPaymentMethodBySale] = useState<Map<number, string>>(new Map());
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
    const today = dayString(0);
    const storeId = effectiveStoreId;

    if (canViewReports) {
      const summary = await getSalesSummary(db, todayRange(), storeId);
      setTodayRevenue(summary.totalRevenue);
      setTodaySaleCount(summary.saleCount);
      const yesterday = dayString(-1);
      const yesterdaySummary = await getSalesSummary(db, { from: yesterday, to: yesterday }, storeId);
      setYesterdayRevenue(yesterdaySummary.totalRevenue);
      const [salesToday, payments] = await Promise.all([
        listSales(db, { from: today, to: today, storeId }),
        listSalePayments(db),
      ]);
      setTodaySales(salesToday);
      setPaymentMethodBySale(new Map(payments.map((p) => [p.referenceId, p.method])));
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

  // --- Héros : ventes du jour (ou, sans droit sur les rapports, mes ventes) ---
  const heroRevenue = canViewReports ? todayRevenue : myTodayRevenue;
  const heroCount = canViewReports ? todaySaleCount : myTodaySaleCount;
  const showHero = canViewReports || canViewOwnSales;
  const heroLabel = canViewReports ? t("dashboard.todaySales") : t("dashboard.mySalesToday");
  const avgBasket = heroCount > 0 ? heroRevenue / heroCount : 0;
  const deltaPct = canViewReports && yesterdayRevenue > 0 ? ((todayRevenue - yesterdayRevenue) / yesterdayRevenue) * 100 : null;

  // --- Courbe par heure (heure locale) ---
  const hourTotals = new Map<number, number>();
  for (const sale of todaySales) {
    const hour = toLocalDate(sale.createdAt).getHours();
    hourTotals.set(hour, (hourTotals.get(hour) ?? 0) + sale.total);
  }
  const hoursWithSales = [...hourTotals.keys()];
  const chartStart = Math.min(8, ...hoursWithSales);
  const chartEnd = Math.max(19, ...hoursWithSales);
  const currentHour = new Date().getHours();
  const hourSlots = Array.from({ length: chartEnd - chartStart + 1 }, (_, i) => chartStart + i);
  const maxHourTotal = Math.max(0, ...hourTotals.values());
  const peakHour = maxHourTotal > 0 ? ([...hourTotals.entries()].find(([, v]) => v === maxHourTotal)?.[0] ?? null) : null;

  // --- À faire ---
  const todos: TodoRow[] = [];
  if (canViewStock && lowStock.length > 0)
    todos.push({ key: "lowStock", title: t("dashboard.lowStock"), detail: t("dashboard.todoLowStockDetail", { count: lowStock.length }), target: "stock" });
  if (canViewStock && expiringBatches.length > 0)
    todos.push({
      key: "expiring",
      title: t("dashboard.expiringSoon", { days: EXPIRY_WARNING_DAYS }),
      detail: t("dashboard.todoExpiringDetail", { count: expiringBatches.length, days: EXPIRY_WARNING_DAYS }),
      target: "stock",
    });
  if (canViewServiceOrders && readyOrderCount > 0)
    todos.push({ key: "ready", title: t("dashboard.readyOrders"), detail: t("dashboard.todoReadyDetail", { count: readyOrderCount }), target: "service_orders" });
  if (canViewCredits && overdueCredits.length > 0)
    todos.push({ key: "credits", title: t("dashboard.overdueCredits"), detail: t("dashboard.todoCreditsDetail", { count: overdueCredits.length }), target: "credits" });
  if (canManageBackups && backupOverdue)
    todos.push({
      key: "backup",
      title: t("dashboard.backup"),
      detail: t("dashboard.todoBackupDetail", { date: lastBackupAt ? lastBackupAt.slice(0, 10) : t("dashboard.backupNever") }),
      target: "settings",
    });

  const dateLabel = new Intl.DateTimeFormat(i18n.language === "en" ? "en-GB" : "fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  const recentSales = todaySales.slice(0, 6);

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontFamily: "var(--font-hand)", fontSize: 24, fontWeight: 600, color: "var(--color-accent)", lineHeight: 1 }}>
            {dateLabel}
          </span>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 700, letterSpacing: "-0.01em" }}>{t("dashboard.title")}</h1>
        </div>
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

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: 22, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 22 }}>
          {showHero && (
            <section
              style={{
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-lg)",
                padding: "24px 26px",
                display: "flex",
                flexWrap: "wrap",
                gap: 28,
                alignItems: "flex-end",
                justifyContent: "space-between",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
                <span style={{ fontSize: 14, color: "var(--color-text-muted)" }}>{heroLabel}</span>
                <span style={{ ...amountStyle, fontSize: "clamp(38px, 6vw, 64px)", fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1 }}>
                  {formatAmount(heroRevenue)}&nbsp;F
                </span>
                {deltaPct !== null && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, color: deltaPct >= 0 ? "var(--color-success)" : "var(--color-danger)" }}>
                      {deltaPct >= 0 ? "▲" : "▼"} {deltaPct >= 0 ? "+" : "−"}
                      {Math.abs(Math.round(deltaPct))} %
                    </span>
                    <span style={{ color: "var(--color-text-muted)" }}>
                      {t("dashboard.vsYesterday", { amount: formatAmount(yesterdayRevenue) })}
                    </span>
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4, width: "min(340px, 100%)", fontSize: 14 }}>
                  <div style={dottedRow}>
                    <span>{t("dashboard.salesLabel")}</span>
                    <span style={dottedLeader} />
                    <span style={{ ...amountStyle, fontWeight: 500 }}>{heroCount}</span>
                  </div>
                  <div style={dottedRow}>
                    <span>{t("dashboard.avgBasket")}</span>
                    <span style={dottedLeader} />
                    <span style={{ ...amountStyle, fontWeight: 500 }}>{formatAmount(avgBasket)}&nbsp;F</span>
                  </div>
                  {canViewReports && canViewOwnSales && (
                    <div style={dottedRow}>
                      <span>{t("dashboard.mySalesToday")}</span>
                      <span style={dottedLeader} />
                      <span style={{ ...amountStyle, fontWeight: 500 }}>{formatAmount(myTodayRevenue)}&nbsp;F</span>
                    </div>
                  )}
                </div>
              </div>

              {canViewReports && (
                <div
                  role="img"
                  aria-label={t("dashboard.chartLabel")}
                  style={{ position: "relative", display: "flex", flexDirection: "column", gap: 8, width: "min(360px, 100%)", paddingTop: 34 }}
                >
                  {peakHour !== null && (
                    <span
                      style={{
                        position: "absolute",
                        top: 0,
                        right: 0,
                        fontFamily: "var(--font-hand)",
                        fontSize: 22,
                        fontWeight: 600,
                        color: "var(--color-accent)",
                        transform: "rotate(-3deg)",
                        lineHeight: 1,
                      }}
                    >
                      {t("dashboard.peakHour", { hour: peakHour })}
                    </span>
                  )}
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: 130, borderBottom: "1px solid var(--color-text)" }}>
                    {hourSlots.map((hour) => {
                      const value = hourTotals.get(hour) ?? 0;
                      const isFuture = hour > currentHour;
                      const height = value > 0 ? Math.max(4, Math.round((value / maxHourTotal) * 120)) : 2;
                      const isCurrent = hour === currentHour && value > 0;
                      return (
                        <div
                          key={hour}
                          style={{
                            flexGrow: 1,
                            height,
                            background: isCurrent ? "var(--color-accent)" : isFuture ? "var(--color-rule-strong)" : "var(--color-dot)",
                          }}
                        />
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", ...amountStyle, fontSize: 11, color: "var(--color-text-muted)" }}>
                    <span>{chartStart} h</span>
                    <span>{Math.round((chartStart + chartEnd) / 2)} h</span>
                    <span>{chartEnd} h</span>
                  </div>
                </div>
              )}
            </section>
          )}

          <section style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{t("dashboard.todoTitle")}</h2>
              <span style={{ flexGrow: 1, borderBottom: "1px dotted var(--color-rule-strong)" }} />
            </div>
            {todos.length === 0 ? (
              <p style={{ margin: "8px 0", fontFamily: "var(--font-hand)", fontSize: 24, fontWeight: 600, color: "var(--color-text-muted)" }}>
                {t("dashboard.todoEmpty")}
              </p>
            ) : (
              todos.map((todo) => (
                <div
                  key={todo.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 12,
                    padding: "14px 0",
                    borderBottom: "1px dashed var(--color-dot)",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                    <span style={{ fontSize: 16, fontWeight: 600 }}>{todo.title}</span>
                    <span style={{ fontSize: 14, color: "var(--color-text-muted)" }}>{todo.detail}</span>
                  </div>
                  {onNavigate && (
                    <button type="button" style={outlineButton} onClick={() => onNavigate(todo.target)}>
                      {t("dashboard.open")}
                    </button>
                  )}
                </div>
              ))
            )}
          </section>
        </div>

        {canViewReports && (
          <aside style={{ flex: "0 1 380px", minWidth: "min(300px, 100%)", display: "flex", flexDirection: "column" }}>
            <div
              style={{
                background: "var(--color-ticket)",
                border: "1px solid var(--color-border)",
                borderBottom: "none",
                padding: "20px 22px 8px",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{t("dashboard.recentSales")}</h2>
              <div style={{ borderBottom: "1px dashed var(--color-rule-strong)", margin: "10px 0 4px" }} />
              {recentSales.length === 0 && (
                <p style={{ margin: "10px 0 14px", fontFamily: "var(--font-hand)", fontSize: 22, fontWeight: 600, color: "var(--color-text-muted)" }}>
                  {t("dashboard.noSalesYet")}
                </p>
              )}
              {recentSales.map((sale) => {
                const method = paymentMethodBySale.get(sale.id);
                return (
                  <div
                    key={sale.id}
                    style={{ display: "flex", flexDirection: "column", gap: 2, padding: "10px 0", borderBottom: "1px dotted var(--color-border)" }}
                  >
                    <div style={{ ...amountStyle, display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 14 }}>
                      <span style={{ fontWeight: 500 }}>{sale.number}</span>
                      <span style={{ fontWeight: 600 }}>{formatAmount(sale.total)}&nbsp;F</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--color-text-muted)" }}>
                      <span>
                        {toLocalDate(sale.createdAt).toLocaleTimeString(i18n.language === "en" ? "en-GB" : "fr-FR", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {method ? ` · ${t(`sales.paymentMethods.${method}`, { defaultValue: method })}` : ""}
                      </span>
                      {sale.paymentStatus !== "paid" && (
                        <span style={badgeStyle(sale.paymentStatus === "credit" ? "danger" : "warning")}>
                          {t(`common.paymentStatus.${sale.paymentStatus}`, { defaultValue: sale.paymentStatus })}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              <div style={{ height: 10 }} />
            </div>
            <svg width="100%" height="10" aria-hidden="true" style={{ display: "block" }}>
              <defs>
                <pattern id="dashTicketEdge" width="14" height="10" patternUnits="userSpaceOnUse">
                  <path d="M0 0H14L7 10Z" style={{ fill: "var(--color-ticket)", stroke: "var(--color-border)" }} strokeWidth="1" />
                </pattern>
              </defs>
              <rect width="100%" height="10" fill="url(#dashTicketEdge)" />
            </svg>
          </aside>
        )}
      </div>
    </main>
  );
}
