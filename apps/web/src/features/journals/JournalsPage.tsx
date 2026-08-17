import {
  getLocationDisplayName,
  getRefundTotalsBySale,
  getSettings,
  hasPermission,
  listAllVariants,
  listAuditLog,
  listBatches,
  listCustomers,
  listLocations,
  listProducts,
  listSales,
  listStockMovements,
  listStores,
  listUsers,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { useAuth } from "../auth/useAuth";
import { FilterBar } from "../../components/FilterBar";
import { inputStyle, pageStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { RefundHistoryModal } from "./RefundHistoryModal";
import { RefundModal } from "./RefundModal";

type Sale = typeof schema.sales.$inferSelect;
type StockMovement = typeof schema.stockMovements.$inferSelect;
type AuditEntry = typeof schema.auditLog.$inferSelect;
type Product = typeof schema.products.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;
type Location = typeof schema.stockLocations.$inferSelect;
type Batch = typeof schema.stockBatches.$inferSelect;
type Customer = typeof schema.customers.$inferSelect;
type User = Awaited<ReturnType<typeof listUsers>>[number];

// Pour les mouvements "loss", referenceType porte le motif (voir StockPage.tsx)
// plutôt qu'une référence à une autre entité — pas de conflit avec les autres
// types de mouvement, qui n'utilisent jamais ces valeurs.

interface SalesFilterState {
  from: string;
  to: string;
  userId: string;
  paymentStatus: string;
  search: string;
  customerSearch: string;
  storeId: string;
}
const EMPTY_SALES_FILTERS: SalesFilterState = {
  from: "",
  to: "",
  userId: "",
  paymentStatus: "",
  search: "",
  customerSearch: "",
  storeId: "",
};

interface StockFilterState {
  from: string;
  to: string;
  userId: string;
  movementType: string;
  locationId: string;
  search: string;
}
const EMPTY_STOCK_FILTERS: StockFilterState = {
  from: "",
  to: "",
  userId: "",
  movementType: "",
  locationId: "",
  search: "",
};

interface ActionFilterState {
  from: string;
  to: string;
  userId: string;
  action: string;
  search: string;
}
const EMPTY_ACTION_FILTERS: ActionFilterState = { from: "", to: "", userId: "", action: "", search: "" };

export function JournalsPage() {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();
  const canManageRefunds = hasPermission(user?.permissions ?? {}, "manage_refunds");
  const [tab, setTab] = useState<"sales" | "stock" | "actions">("sales");
  const [refundingSale, setRefundingSale] = useState<Sale | null>(null);
  const [historySale, setHistorySale] = useState<Sale | null>(null);
  const [refundTotals, setRefundTotals] = useState<Record<number, number>>({});

  const [sales, setSales] = useState<Sale[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [stores, setStores] = useState<Awaited<ReturnType<typeof listStores>>>([]);
  const [multiStoreEnabled, setMultiStoreEnabled] = useState(false);

  const [salesFilters, setSalesFilters] = useState<SalesFilterState>(EMPTY_SALES_FILTERS);
  const [stockFilters, setStockFilters] = useState<StockFilterState>(EMPTY_STOCK_FILTERS);
  const [actionFilters, setActionFilters] = useState<ActionFilterState>(EMPTY_ACTION_FILTERS);

  const PAYMENT_STATUS_LABELS: Record<string, string> = {
    paid: t("common.paymentStatus.paid"),
    partial: t("common.paymentStatus.partial"),
    credit: t("common.paymentStatus.credit"),
  };

  const MOVEMENT_TYPE_LABELS: Record<string, string> = {
    purchase: t("journals.movementTypes.purchase"),
    sale: t("journals.movementTypes.sale"),
    transfer: t("journals.movementTypes.transfer"),
    adjustment: t("journals.movementTypes.adjustment"),
    loss: t("journals.movementTypes.loss"),
    return: t("journals.movementTypes.return"),
  };

  const LOSS_REASON_LABELS: Record<string, string> = {
    expiry: t("journals.lossReasons.expiry"),
    damage: t("journals.lossReasons.damage"),
    theft: t("journals.lossReasons.theft"),
    other: t("journals.lossReasons.other"),
  };

  const ACTION_LABELS: Record<string, string> = {
    create_sale: t("journals.actionLabels.create_sale"),
    create_refund: t("journals.actionLabels.create_refund"),
    create_product: t("journals.actionLabels.create_product"),
    update_product: t("journals.actionLabels.update_product"),
    create_category: t("journals.actionLabels.create_category"),
    create_user: t("journals.actionLabels.create_user"),
    update_user: t("journals.actionLabels.update_user"),
    activate_user: t("journals.actionLabels.activate_user"),
    deactivate_user: t("journals.actionLabels.deactivate_user"),
    impersonate_user: t("journals.actionLabels.impersonate_user"),
    open_cash_session: t("journals.actionLabels.open_cash_session"),
    close_cash_session: t("journals.actionLabels.close_cash_session"),
    create_customer: t("journals.actionLabels.create_customer"),
    update_customer: t("journals.actionLabels.update_customer"),
    create_supplier: t("journals.actionLabels.create_supplier"),
    update_supplier: t("journals.actionLabels.update_supplier"),
    create_purchase: t("journals.actionLabels.create_purchase"),
    record_credit_repayment: t("journals.actionLabels.record_credit_repayment"),
    record_debt_payment: t("journals.actionLabels.record_debt_payment"),
    adjust_loyalty_points: t("journals.actionLabels.adjust_loyalty_points"),
    create_service_order: t("journals.actionLabels.create_service_order"),
    update_service_order: t("journals.actionLabels.update_service_order"),
    update_service_order_item: t("journals.actionLabels.update_service_order_item"),
    update_service_order_item_status: t("journals.actionLabels.update_service_order_item_status"),
    set_maintenance_code: t("journals.actionLabels.set_maintenance_code"),
    change_maintenance_code: t("journals.actionLabels.change_maintenance_code"),
    create_expense: t("journals.actionLabels.create_expense"),
    update_expense: t("journals.actionLabels.update_expense"),
    delete_expense: t("journals.actionLabels.delete_expense"),
  };

  const refreshReference = useCallback(async () => {
    const [productRows, variantRows, locationRows, batchRows, userRows, customerRows, storeRows, settings] =
      await Promise.all([
        listProducts(db),
        listAllVariants(db),
        listLocations(db),
        listBatches(db),
        listUsers(db),
        listCustomers(db),
        listStores(db),
        getSettings(db),
      ]);
    setProducts(productRows);
    setVariants(variantRows);
    setLocations(locationRows);
    setBatches(batchRows);
    setUsers(userRows);
    setCustomers(customerRows);
    setStores(storeRows);
    setMultiStoreEnabled(settings.multiStoreEnabled);
  }, [db]);

  useEffect(() => {
    refreshReference();
  }, [refreshReference]);

  const refreshSales = useCallback(async () => {
    const [rows, totals] = await Promise.all([
      listSales(db, {
        from: salesFilters.from || undefined,
        to: salesFilters.to || undefined,
        userId: salesFilters.userId ? Number(salesFilters.userId) : undefined,
        paymentStatus: salesFilters.paymentStatus || undefined,
        search: salesFilters.search || undefined,
      }),
      getRefundTotalsBySale(db),
    ]);
    setSales(rows);
    setRefundTotals(totals);
  }, [db, salesFilters]);

  useEffect(() => {
    refreshSales();
  }, [refreshSales]);

  const refreshStock = useCallback(async () => {
    const rows = await listStockMovements(db, {
      from: stockFilters.from || undefined,
      to: stockFilters.to || undefined,
      userId: stockFilters.userId ? Number(stockFilters.userId) : undefined,
      movementType: stockFilters.movementType || undefined,
      locationId: stockFilters.locationId ? Number(stockFilters.locationId) : undefined,
    });
    setMovements(rows);
  }, [db, stockFilters]);

  useEffect(() => {
    refreshStock();
  }, [refreshStock]);

  const refreshActions = useCallback(async () => {
    const rows = await listAuditLog(db, {
      from: actionFilters.from || undefined,
      to: actionFilters.to || undefined,
      userId: actionFilters.userId ? Number(actionFilters.userId) : undefined,
      action: actionFilters.action || undefined,
      search: actionFilters.search || undefined,
    });
    setAuditEntries(rows);
  }, [db, actionFilters]);

  useEffect(() => {
    refreshActions();
  }, [refreshActions]);

  const userName = (userId: number | null) => users.find((u) => u.id === userId)?.fullName ?? "—";
  const locationName = (locationId: number) => {
    const name = locations.find((l) => l.id === locationId)?.name;
    return name ? getLocationDisplayName(name) : "—";
  };
  const customerName = (customerId: number | null) => customers.find((c) => c.id === customerId)?.fullName ?? null;
  const storeName = (storeId: number | null) => stores.find((s) => s.id === storeId)?.name ?? "—";
  const variantLabel = (variantId: number) => {
    const variant = variants.find((v) => v.id === variantId);
    const product = products.find((p) => p.id === variant?.productId);
    return product?.name ?? "—";
  };
  // Traçabilité fine vente/remboursement ↔ lot précis — batchId n'est posé
  // que sur les mouvements passés par consumeStockFefo ou par le retour
  // batch-aware de RefundsService ; les autres (ex. approvisionnement
  // manuel non lié à un lot) restent sans lot associé, d'où le "—".
  const lotLabel = (batchId: number | null) => {
    if (batchId == null) return "—";
    const batch = batches.find((b) => b.id === batchId);
    return batch?.lotNumber ?? `#${batchId}`;
  };

  // Filtre texte sur le nom de produit — côté client, la table stock_movements
  // ne stocke qu'un variantId (une jointure SQL pour un simple filtre de
  // journal n'apporterait rien).
  const filteredMovements = useMemo(() => {
    const term = stockFilters.search.trim().toLowerCase();
    if (!term) return movements;
    return movements.filter((m) => variantLabel(m.variantId).toLowerCase().includes(term));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movements, stockFilters.search, variants, products]);

  // Filtre texte sur le nom du client (et, si multi-boutique, sur la
  // boutique) — côté client, même raisonnement que pour le produit ci-dessus
  // (sales ne stocke qu'un customerId).
  const filteredSales = useMemo(() => {
    const term = salesFilters.customerSearch.trim().toLowerCase();
    const storeId = salesFilters.storeId ? Number(salesFilters.storeId) : null;
    return sales.filter((s) => {
      if (term && !(customerName(s.customerId) ?? "").toLowerCase().includes(term)) return false;
      if (storeId && s.storeId !== storeId) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sales, salesFilters.customerSearch, salesFilters.storeId, customers]);

  const knownActions = useMemo(() => Object.keys(ACTION_LABELS).sort(), []);

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1>{t("journals.title")}</h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {(["sales", "stock", "actions"] as const).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                ...primaryButtonStyle,
                background: tab === key ? "var(--gradient-accent)" : "transparent",
                color: tab === key ? "#0f172a" : "var(--color-text)",
                border: tab === key ? "none" : "1px solid var(--color-border)",
              }}
            >
              {t(`journals.tabs.${key}`)}
            </button>
          ))}
        </div>
      </div>

      {tab === "sales" && (
        <>
          <FilterBar
            from={salesFilters.from}
            onFromChange={(v) => setSalesFilters((f) => ({ ...f, from: v }))}
            to={salesFilters.to}
            onToChange={(v) => setSalesFilters((f) => ({ ...f, to: v }))}
            search={salesFilters.search}
            onSearchChange={(v) => setSalesFilters((f) => ({ ...f, search: v }))}
            searchPlaceholder={t("journals.sales.searchPlaceholder")}
            onReset={() => setSalesFilters(EMPTY_SALES_FILTERS)}
          >
            <label>
              {t("journals.sales.cashier")}
              <select
                style={inputStyle}
                value={salesFilters.userId}
                onChange={(e) => setSalesFilters((f) => ({ ...f, userId: e.target.value }))}
              >
                <option value="">{t("journals.sales.all")}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("journals.sales.paymentStatus")}
              <select
                style={inputStyle}
                value={salesFilters.paymentStatus}
                onChange={(e) => setSalesFilters((f) => ({ ...f, paymentStatus: e.target.value }))}
              >
                <option value="">{t("journals.sales.all")}</option>
                {Object.entries(PAYMENT_STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("journals.sales.customer")}
              <input
                style={inputStyle}
                value={salesFilters.customerSearch}
                onChange={(e) => setSalesFilters((f) => ({ ...f, customerSearch: e.target.value }))}
                placeholder={t("journals.sales.customerNamePlaceholder")}
              />
            </label>
            {multiStoreEnabled && (
              <label>
                {t("journals.sales.store")}
                <select
                  style={inputStyle}
                  value={salesFilters.storeId}
                  onChange={(e) => setSalesFilters((f) => ({ ...f, storeId: e.target.value }))}
                >
                  <option value="">{t("journals.sales.allStores")}</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </FilterBar>

          <div className="table-scroll">
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("journals.sales.number")}</th>
                  <th style={thStyle}>{t("journals.sales.date")}</th>
                  <th style={thStyle}>{t("journals.sales.customer")}</th>
                  <th style={thStyle}>{t("journals.sales.mode")}</th>
                  {multiStoreEnabled && <th style={thStyle}>{t("journals.sales.store")}</th>}
                  <th style={thStyle}>{t("journals.sales.total")}</th>
                  <th style={thStyle}>{t("journals.sales.payment")}</th>
                  <th style={thStyle}>{t("journals.sales.cashier")}</th>
                  {canManageRefunds && <th style={thStyle}>{t("journals.sales.refundColumn")}</th>}
                </tr>
              </thead>
              <tbody>
                {filteredSales.map((sale) => (
                  <tr key={sale.id}>
                    <td style={tdStyle}>{sale.number}</td>
                    <td style={tdStyle}>{sale.createdAt}</td>
                    <td style={tdStyle}>{customerName(sale.customerId) ?? "—"}</td>
                    <td style={tdStyle}>{sale.saleMode === "pos" ? t("journals.sales.modePos") : t("journals.sales.modeForm")}</td>
                    {multiStoreEnabled && <td style={tdStyle}>{storeName(sale.storeId)}</td>}
                    <td style={tdStyle}>{sale.total}</td>
                    <td style={tdStyle}>{PAYMENT_STATUS_LABELS[sale.paymentStatus] ?? sale.paymentStatus}</td>
                    <td style={tdStyle}>{userName(sale.userId)}</td>
                    {canManageRefunds && (
                      <td style={{ ...tdStyle, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                        {sale.status === "refunded" && <span style={{ color: "#f87171" }}>{t("journals.sales.refunded")}</span>}
                        {sale.status !== "refunded" && (refundTotals[sale.id] ?? 0) > 0 && (
                          <span style={{ color: "#fdba74" }}>{t("journals.sales.partiallyRefunded")}</span>
                        )}
                        {(refundTotals[sale.id] ?? 0) > 0 && (
                          <button
                            onClick={() => setHistorySale(sale)}
                            style={{
                              background: "transparent",
                              border: "1px solid var(--color-border)",
                              color: "var(--color-text)",
                              borderRadius: "var(--radius-md)",
                              padding: "6px 12px",
                              cursor: "pointer",
                            }}
                          >
                            {t("journals.sales.history")}
                          </button>
                        )}
                        {sale.status !== "refunded" && (
                          <button
                            onClick={() => setRefundingSale(sale)}
                            style={{
                              background: "transparent",
                              border: "1px solid var(--color-border)",
                              color: "var(--color-text)",
                              borderRadius: "var(--radius-md)",
                              padding: "6px 12px",
                              cursor: "pointer",
                            }}
                          >
                            {t("journals.sales.refund")}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {filteredSales.length === 0 && (
                  <tr>
                    <td
                      style={tdStyle}
                      colSpan={7 + (multiStoreEnabled ? 1 : 0) + (canManageRefunds ? 1 : 0)}
                    >
                      {t("journals.sales.noSales")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {refundingSale && (
        <RefundModal
          sale={refundingSale}
          variantLabel={variantLabel}
          onClose={() => setRefundingSale(null)}
          onDone={refreshSales}
        />
      )}

      {historySale && (
        <RefundHistoryModal sale={historySale} variantLabel={variantLabel} onClose={() => setHistorySale(null)} />
      )}

      {tab === "stock" && (
        <>
          <FilterBar
            from={stockFilters.from}
            onFromChange={(v) => setStockFilters((f) => ({ ...f, from: v }))}
            to={stockFilters.to}
            onToChange={(v) => setStockFilters((f) => ({ ...f, to: v }))}
            search={stockFilters.search}
            onSearchChange={(v) => setStockFilters((f) => ({ ...f, search: v }))}
            searchPlaceholder={t("journals.stock.searchPlaceholder")}
            onReset={() => setStockFilters(EMPTY_STOCK_FILTERS)}
          >
            <label>
              {t("journals.stock.user")}
              <select
                style={inputStyle}
                value={stockFilters.userId}
                onChange={(e) => setStockFilters((f) => ({ ...f, userId: e.target.value }))}
              >
                <option value="">{t("journals.stock.all")}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("journals.stock.movementType")}
              <select
                style={inputStyle}
                value={stockFilters.movementType}
                onChange={(e) => setStockFilters((f) => ({ ...f, movementType: e.target.value }))}
              >
                <option value="">{t("journals.stock.all")}</option>
                {Object.entries(MOVEMENT_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("journals.stock.location")}
              <select
                style={inputStyle}
                value={stockFilters.locationId}
                onChange={(e) => setStockFilters((f) => ({ ...f, locationId: e.target.value }))}
              >
                <option value="">{t("journals.stock.all")}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </FilterBar>

          <div className="table-scroll">
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("journals.stock.date")}</th>
                  <th style={thStyle}>{t("journals.stock.product")}</th>
                  <th style={thStyle}>{t("journals.stock.location")}</th>
                  <th style={thStyle}>{t("journals.stock.type")}</th>
                  <th style={thStyle}>{t("journals.stock.reason")}</th>
                  <th style={thStyle}>{t("journals.stock.lot")}</th>
                  <th style={thStyle}>{t("journals.stock.quantity")}</th>
                  <th style={thStyle}>{t("journals.stock.user")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredMovements.map((m) => (
                  <tr key={m.id}>
                    <td style={tdStyle}>{m.createdAt}</td>
                    <td style={tdStyle}>{variantLabel(m.variantId)}</td>
                    <td style={tdStyle}>{locationName(m.locationId)}</td>
                    <td style={tdStyle}>{MOVEMENT_TYPE_LABELS[m.movementType] ?? m.movementType}</td>
                    <td style={tdStyle}>
                      {m.movementType === "loss" ? (LOSS_REASON_LABELS[m.referenceType ?? ""] ?? "—") : "—"}
                    </td>
                    <td style={tdStyle}>{lotLabel(m.batchId)}</td>
                    <td style={{ ...tdStyle, color: m.quantityDelta < 0 ? "#f87171" : "#86efac" }}>
                      {m.quantityDelta > 0 ? "+" : ""}
                      {m.quantityDelta}
                    </td>
                    <td style={tdStyle}>{userName(m.createdBy)}</td>
                  </tr>
                ))}
                {filteredMovements.length === 0 && (
                  <tr>
                    <td style={tdStyle} colSpan={8}>
                      {t("journals.stock.noMovements")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "actions" && (
        <>
          <FilterBar
            from={actionFilters.from}
            onFromChange={(v) => setActionFilters((f) => ({ ...f, from: v }))}
            to={actionFilters.to}
            onToChange={(v) => setActionFilters((f) => ({ ...f, to: v }))}
            search={actionFilters.search}
            onSearchChange={(v) => setActionFilters((f) => ({ ...f, search: v }))}
            searchPlaceholder={t("journals.actions.searchPlaceholder")}
            onReset={() => setActionFilters(EMPTY_ACTION_FILTERS)}
          >
            <label>
              {t("journals.actions.user")}
              <select
                style={inputStyle}
                value={actionFilters.userId}
                onChange={(e) => setActionFilters((f) => ({ ...f, userId: e.target.value }))}
              >
                <option value="">{t("journals.actions.all")}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("journals.actions.action")}
              <select
                style={inputStyle}
                value={actionFilters.action}
                onChange={(e) => setActionFilters((f) => ({ ...f, action: e.target.value }))}
              >
                <option value="">{t("journals.actions.allActions")}</option>
                {knownActions.map((action) => (
                  <option key={action} value={action}>
                    {ACTION_LABELS[action]}
                  </option>
                ))}
              </select>
            </label>
          </FilterBar>

          <div className="table-scroll">
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("journals.actions.date")}</th>
                  <th style={thStyle}>{t("journals.actions.user")}</th>
                  <th style={thStyle}>{t("journals.actions.action")}</th>
                  <th style={thStyle}>{t("journals.actions.details")}</th>
                </tr>
              </thead>
              <tbody>
                {auditEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td style={tdStyle}>{entry.createdAt}</td>
                    <td style={tdStyle}>{userName(entry.userId)}</td>
                    <td style={tdStyle}>{ACTION_LABELS[entry.action] ?? entry.action}</td>
                    <td style={tdStyle}>
                      {entry.metadata
                        ? Object.entries(JSON.parse(entry.metadata) as Record<string, unknown>)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(", ")
                        : "—"}
                    </td>
                  </tr>
                ))}
                {auditEntries.length === 0 && (
                  <tr>
                    <td style={tdStyle} colSpan={4}>
                      {t("journals.actions.noActions")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
