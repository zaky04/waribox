import {
  getSettings,
  listAllVariants,
  listCustomers,
  listProducts,
  listSaleItems,
  listSalePayments,
  listSales,
  listStores,
  listUsers,
  type PaymentMethod,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { buildReceiptPdf, type ReceiptData } from "@gestion-boutique/printer";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { FilterBar } from "../../components/FilterBar";
import { SearchableSelect } from "../../components/SearchableSelect";
import { inputStyle, pageStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";

type Sale = typeof schema.sales.$inferSelect;
type Payment = typeof schema.payments.$inferSelect;
type Product = typeof schema.products.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;
type Customer = typeof schema.customers.$inferSelect;
type User = Awaited<ReturnType<typeof listUsers>>[number];

function timestampForFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface FilterState {
  from: string;
  to: string;
  userId: string;
  storeId: string;
  customerId: string;
  paymentMethod: string;
  search: string;
}
const EMPTY_FILTERS: FilterState = {
  from: "",
  to: "",
  userId: "",
  storeId: "",
  customerId: "",
  paymentMethod: "",
  search: "",
};

export function SalesHistoryPage() {
  const db = useDatabase();
  const { t } = useTranslation();
  const PAYMENT_STATUS_LABELS: Record<string, string> = {
    paid: t("common.paymentStatus.paid"),
    partial: t("common.paymentStatus.partial"),
    credit: t("common.paymentStatus.credit"),
  };
  const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
    cash: t("sales.paymentMethods.cash"),
    card: t("sales.paymentMethods.card"),
    mobile_money: t("sales.paymentMethods.mobile_money"),
    credit: t("sales.paymentMethods.credit"),
  };
  const [sales, setSales] = useState<Sale[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [stores, setStores] = useState<Awaited<ReturnType<typeof listStores>>>([]);
  const [multiStoreEnabled, setMultiStoreEnabled] = useState(false);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(null);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [reportError, setReportError] = useState<string | null>(null);
  const [generatingSaleId, setGeneratingSaleId] = useState<number | null>(null);

  const refreshReference = useCallback(async () => {
    const [productRows, variantRows, userRows, customerRows, storeRows, salePayments, businessSettings] =
      await Promise.all([
        listProducts(db),
        listAllVariants(db),
        listUsers(db),
        listCustomers(db),
        listStores(db),
        listSalePayments(db),
        getSettings(db),
      ]);
    setProducts(productRows);
    setVariants(variantRows);
    setUsers(userRows);
    setCustomers(customerRows);
    setStores(storeRows);
    setPayments(salePayments);
    setSettings(businessSettings);
    setMultiStoreEnabled(businessSettings.multiStoreEnabled);
  }, [db]);

  useEffect(() => {
    refreshReference();
  }, [refreshReference]);

  const refreshSales = useCallback(async () => {
    const rows = await listSales(db, {
      from: filters.from || undefined,
      to: filters.to || undefined,
      userId: filters.userId ? Number(filters.userId) : undefined,
      storeId: filters.storeId ? Number(filters.storeId) : undefined,
      customerId: filters.customerId ? Number(filters.customerId) : undefined,
      paymentMethod: filters.paymentMethod || undefined,
      search: filters.search || undefined,
    });
    setSales(rows);
  }, [db, filters]);

  useEffect(() => {
    refreshSales();
  }, [refreshSales]);

  const userName = (userId: number) => users.find((u) => u.id === userId)?.fullName ?? "—";
  const customerName = (customerId: number | null) => customers.find((c) => c.id === customerId)?.fullName ?? null;
  const storeName = (storeId: number | null) => stores.find((s) => s.id === storeId)?.name ?? "—";
  const variantLabel = (variantId: number) => {
    const variant = variants.find((v) => v.id === variantId);
    const product = products.find((p) => p.id === variant?.productId);
    return product?.name ?? "—";
  };
  const paymentForSale = (saleId: number) => payments.find((p) => p.referenceId === saleId);

  const customerOptions = useMemo(
    () => customers.map((c) => ({ value: String(c.id), label: c.fullName })),
    [customers],
  );

  const handleGenerateReport = async (sale: Sale) => {
    setReportError(null);
    setGeneratingSaleId(sale.id);
    try {
      const items = await listSaleItems(db, sale.id);
      const payment = paymentForSale(sale.id);
      const receiptData: ReceiptData = {
        businessName: settings?.businessName ?? undefined,
        businessAddress: settings?.address ?? undefined,
        businessPhone: settings?.phone ?? undefined,
        businessEmail: settings?.email ?? undefined,
        logoDataUrl: settings?.logoDataUrl ?? undefined,
        columns: settings?.receiptColumns,
        saleNumber: sale.number,
        date: sale.createdAt,
        cashierName: userName(sale.userId),
        customerName: customerName(sale.customerId) ?? undefined,
        lines: items.map((item) => ({
          label: variantLabel(item.variantId),
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          total: item.total,
        })),
        subtotal: sale.subtotal,
        discount: sale.discount,
        tax: sale.taxTotal,
        total: sale.total,
        paymentMethod: payment?.method ?? "cash",
        amountPaid: payment?.amount ?? sale.total,
      };
      const blob = buildReceiptPdf(receiptData);
      downloadBlob(blob, `rapport-vente-${sale.number}-${timestampForFilename()}.pdf`);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : t("salesHistory.reportError"));
    } finally {
      setGeneratingSaleId(null);
    }
  };

  return (
    <main style={pageStyle}>
      <h1>{t("salesHistory.title")}</h1>

      {reportError && <div style={{ color: "#f87171" }}>{reportError}</div>}

      <FilterBar
        from={filters.from}
        onFromChange={(v) => setFilters((f) => ({ ...f, from: v }))}
        to={filters.to}
        onToChange={(v) => setFilters((f) => ({ ...f, to: v }))}
        search={filters.search}
        onSearchChange={(v) => setFilters((f) => ({ ...f, search: v }))}
        searchPlaceholder={t("salesHistory.searchPlaceholder")}
        onReset={() => setFilters(EMPTY_FILTERS)}
      >
        <label>
          {t("salesHistory.seller")}
          <select
            style={inputStyle}
            value={filters.userId}
            onChange={(e) => setFilters((f) => ({ ...f, userId: e.target.value }))}
          >
            <option value="">{t("salesHistory.all")}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
              </option>
            ))}
          </select>
        </label>
        {multiStoreEnabled && (
          <label>
            {t("salesHistory.store")}
            <select
              style={inputStyle}
              value={filters.storeId}
              onChange={(e) => setFilters((f) => ({ ...f, storeId: e.target.value }))}
            >
              <option value="">{t("salesHistory.allStores")}</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {t("salesHistory.paymentMethod")}
          <select
            style={inputStyle}
            value={filters.paymentMethod}
            onChange={(e) => setFilters((f) => ({ ...f, paymentMethod: e.target.value }))}
          >
            <option value="">{t("salesHistory.all")}</option>
            {Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ minWidth: 220 }}>
          {t("salesHistory.customer")}
          <SearchableSelect
            options={customerOptions}
            value={filters.customerId}
            onChange={(v) => setFilters((f) => ({ ...f, customerId: v }))}
            placeholder={t("salesHistory.allCustomers")}
            emptyLabel={t("salesHistory.noCustomer")}
          />
        </label>
      </FilterBar>

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>{t("salesHistory.number")}</th>
            <th style={thStyle}>{t("salesHistory.date")}</th>
            <th style={thStyle}>{t("salesHistory.customer")}</th>
            {multiStoreEnabled && <th style={thStyle}>{t("salesHistory.store")}</th>}
            <th style={thStyle}>{t("salesHistory.seller")}</th>
            <th style={thStyle}>{t("salesHistory.paymentMethod")}</th>
            <th style={thStyle}>{t("salesHistory.total")}</th>
            <th style={thStyle}>{t("salesHistory.status")}</th>
            <th style={thStyle}>{t("salesHistory.report")}</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((sale) => (
            <tr key={sale.id}>
              <td style={tdStyle}>{sale.number}</td>
              <td style={tdStyle}>{sale.createdAt}</td>
              <td style={tdStyle}>{customerName(sale.customerId) ?? "—"}</td>
              {multiStoreEnabled && <td style={tdStyle}>{storeName(sale.storeId)}</td>}
              <td style={tdStyle}>{userName(sale.userId)}</td>
              <td style={tdStyle}>
                {(() => {
                  const method = paymentForSale(sale.id)?.method;
                  return method ? (PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method) : "—";
                })()}
              </td>
              <td style={tdStyle}>{sale.total}</td>
              <td style={tdStyle}>{PAYMENT_STATUS_LABELS[sale.paymentStatus] ?? sale.paymentStatus}</td>
              <td style={tdStyle}>
                <button
                  style={{ ...primaryButtonStyle, padding: "6px 12px" }}
                  disabled={generatingSaleId === sale.id}
                  onClick={() => handleGenerateReport(sale)}
                >
                  {generatingSaleId === sale.id ? t("salesHistory.generating") : t("salesHistory.report")}
                </button>
              </td>
            </tr>
          ))}
          {sales.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={8 + (multiStoreEnabled ? 1 : 0)}>
                {t("salesHistory.noSales")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
