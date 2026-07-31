import {
  listAllVariants,
  listAuditLog,
  listCustomers,
  listLocations,
  listProducts,
  listSales,
  listStockMovements,
  listUsers,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDatabase } from "../../app/DatabaseProvider";
import { FilterBar } from "../../components/FilterBar";
import { inputStyle, pageStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";

type Sale = typeof schema.sales.$inferSelect;
type StockMovement = typeof schema.stockMovements.$inferSelect;
type AuditEntry = typeof schema.auditLog.$inferSelect;
type Product = typeof schema.products.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;
type Location = typeof schema.stockLocations.$inferSelect;
type Customer = typeof schema.customers.$inferSelect;
type User = Awaited<ReturnType<typeof listUsers>>[number];

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  paid: "Payée",
  partial: "Partielle",
  credit: "Crédit",
};

const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  purchase: "Achat",
  sale: "Vente",
  transfer: "Transfert",
  adjustment: "Ajustement",
  loss: "Perte",
};

// Pour les mouvements "loss", referenceType porte le motif (voir StockPage.tsx)
// plutôt qu'une référence à une autre entité — pas de conflit avec les autres
// types de mouvement, qui n'utilisent jamais ces valeurs.
const LOSS_REASON_LABELS: Record<string, string> = {
  expiry: "Péremption",
  damage: "Casse / Destruction",
  theft: "Vol",
  other: "Autre",
};

const ACTION_LABELS: Record<string, string> = {
  create_sale: "Vente enregistrée",
  create_product: "Produit créé",
  create_category: "Catégorie créée",
  create_user: "Utilisateur créé",
  activate_user: "Utilisateur activé",
  deactivate_user: "Utilisateur désactivé",
  open_cash_session: "Caisse ouverte",
  close_cash_session: "Caisse fermée",
  create_customer: "Client créé",
  update_customer: "Client modifié",
  create_supplier: "Fournisseur créé",
  update_supplier: "Fournisseur modifié",
  create_purchase: "Achat enregistré",
  record_credit_repayment: "Remboursement créance enregistré",
  record_debt_payment: "Paiement dette enregistré",
  adjust_loyalty_points: "Points fidélité ajustés",
  create_service_order: "Ticket de service créé",
  update_service_order: "Ticket de service modifié",
  update_service_order_item: "Article de ticket modifié",
  update_service_order_item_status: "Statut d'article modifié",
  set_maintenance_code: "Code de maintenance défini",
  change_maintenance_code: "Code de maintenance changé",
  create_expense: "Dépense enregistrée",
  update_expense: "Dépense modifiée",
  delete_expense: "Dépense supprimée",
};

interface SalesFilterState {
  from: string;
  to: string;
  userId: string;
  paymentStatus: string;
  search: string;
  customerSearch: string;
}
const EMPTY_SALES_FILTERS: SalesFilterState = {
  from: "",
  to: "",
  userId: "",
  paymentStatus: "",
  search: "",
  customerSearch: "",
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
  const [tab, setTab] = useState<"sales" | "stock" | "actions">("sales");

  const [sales, setSales] = useState<Sale[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);

  const [salesFilters, setSalesFilters] = useState<SalesFilterState>(EMPTY_SALES_FILTERS);
  const [stockFilters, setStockFilters] = useState<StockFilterState>(EMPTY_STOCK_FILTERS);
  const [actionFilters, setActionFilters] = useState<ActionFilterState>(EMPTY_ACTION_FILTERS);

  const refreshReference = useCallback(async () => {
    const [productRows, variantRows, locationRows, userRows, customerRows] = await Promise.all([
      listProducts(db),
      listAllVariants(db),
      listLocations(db),
      listUsers(db),
      listCustomers(db),
    ]);
    setProducts(productRows);
    setVariants(variantRows);
    setLocations(locationRows);
    setUsers(userRows);
    setCustomers(customerRows);
  }, [db]);

  useEffect(() => {
    refreshReference();
  }, [refreshReference]);

  const refreshSales = useCallback(async () => {
    const rows = await listSales(db, {
      from: salesFilters.from || undefined,
      to: salesFilters.to || undefined,
      userId: salesFilters.userId ? Number(salesFilters.userId) : undefined,
      paymentStatus: salesFilters.paymentStatus || undefined,
      search: salesFilters.search || undefined,
    });
    setSales(rows);
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
  const locationName = (locationId: number) => locations.find((l) => l.id === locationId)?.name ?? "—";
  const customerName = (customerId: number | null) => customers.find((c) => c.id === customerId)?.fullName ?? null;
  const variantLabel = (variantId: number) => {
    const variant = variants.find((v) => v.id === variantId);
    const product = products.find((p) => p.id === variant?.productId);
    return product?.name ?? "—";
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

  // Filtre texte sur le nom du client — côté client, même raisonnement que
  // pour le produit ci-dessus (sales ne stocke qu'un customerId).
  const filteredSales = useMemo(() => {
    const term = salesFilters.customerSearch.trim().toLowerCase();
    if (!term) return sales;
    return sales.filter((s) => (customerName(s.customerId) ?? "").toLowerCase().includes(term));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sales, salesFilters.customerSearch, customers]);

  const knownActions = useMemo(() => Object.keys(ACTION_LABELS).sort(), []);

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Journaux</h1>
        <div style={{ display: "flex", gap: 8 }}>
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
              {key === "sales" ? "Ventes" : key === "stock" ? "Stock" : "Actions"}
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
            searchPlaceholder="Numéro de vente..."
            onReset={() => setSalesFilters(EMPTY_SALES_FILTERS)}
          >
            <label>
              Caissier
              <select
                style={inputStyle}
                value={salesFilters.userId}
                onChange={(e) => setSalesFilters((f) => ({ ...f, userId: e.target.value }))}
              >
                <option value="">Tous</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Statut paiement
              <select
                style={inputStyle}
                value={salesFilters.paymentStatus}
                onChange={(e) => setSalesFilters((f) => ({ ...f, paymentStatus: e.target.value }))}
              >
                <option value="">Tous</option>
                {Object.entries(PAYMENT_STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Client
              <input
                style={inputStyle}
                value={salesFilters.customerSearch}
                onChange={(e) => setSalesFilters((f) => ({ ...f, customerSearch: e.target.value }))}
                placeholder="Nom du client..."
              />
            </label>
          </FilterBar>

          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Numéro</th>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Client</th>
                <th style={thStyle}>Mode</th>
                <th style={thStyle}>Total</th>
                <th style={thStyle}>Paiement</th>
                <th style={thStyle}>Caissier</th>
              </tr>
            </thead>
            <tbody>
              {filteredSales.map((sale) => (
                <tr key={sale.id}>
                  <td style={tdStyle}>{sale.number}</td>
                  <td style={tdStyle}>{sale.createdAt}</td>
                  <td style={tdStyle}>{customerName(sale.customerId) ?? "—"}</td>
                  <td style={tdStyle}>{sale.saleMode === "pos" ? "Caisse" : "Formulaire"}</td>
                  <td style={tdStyle}>{sale.total}</td>
                  <td style={tdStyle}>{PAYMENT_STATUS_LABELS[sale.paymentStatus] ?? sale.paymentStatus}</td>
                  <td style={tdStyle}>{userName(sale.userId)}</td>
                </tr>
              ))}
              {filteredSales.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={7}>
                    Aucune vente pour cette sélection.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
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
            searchPlaceholder="Nom du produit..."
            onReset={() => setStockFilters(EMPTY_STOCK_FILTERS)}
          >
            <label>
              Utilisateur
              <select
                style={inputStyle}
                value={stockFilters.userId}
                onChange={(e) => setStockFilters((f) => ({ ...f, userId: e.target.value }))}
              >
                <option value="">Tous</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Type de mouvement
              <select
                style={inputStyle}
                value={stockFilters.movementType}
                onChange={(e) => setStockFilters((f) => ({ ...f, movementType: e.target.value }))}
              >
                <option value="">Tous</option>
                {Object.entries(MOVEMENT_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Emplacement
              <select
                style={inputStyle}
                value={stockFilters.locationId}
                onChange={(e) => setStockFilters((f) => ({ ...f, locationId: e.target.value }))}
              >
                <option value="">Tous</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </FilterBar>

          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Produit</th>
                <th style={thStyle}>Emplacement</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Motif</th>
                <th style={thStyle}>Quantité</th>
                <th style={thStyle}>Utilisateur</th>
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
                  <td style={{ ...tdStyle, color: m.quantityDelta < 0 ? "#f87171" : "#86efac" }}>
                    {m.quantityDelta > 0 ? "+" : ""}
                    {m.quantityDelta}
                  </td>
                  <td style={tdStyle}>{userName(m.createdBy)}</td>
                </tr>
              ))}
              {filteredMovements.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={7}>
                    Aucun mouvement de stock pour cette sélection.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
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
            searchPlaceholder="Recherche libre..."
            onReset={() => setActionFilters(EMPTY_ACTION_FILTERS)}
          >
            <label>
              Utilisateur
              <select
                style={inputStyle}
                value={actionFilters.userId}
                onChange={(e) => setActionFilters((f) => ({ ...f, userId: e.target.value }))}
              >
                <option value="">Tous</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Action
              <select
                style={inputStyle}
                value={actionFilters.action}
                onChange={(e) => setActionFilters((f) => ({ ...f, action: e.target.value }))}
              >
                <option value="">Toutes</option>
                {knownActions.map((action) => (
                  <option key={action} value={action}>
                    {ACTION_LABELS[action]}
                  </option>
                ))}
              </select>
            </label>
          </FilterBar>

          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Utilisateur</th>
                <th style={thStyle}>Action</th>
                <th style={thStyle}>Détails</th>
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
                    Aucune action enregistrée pour cette sélection.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
