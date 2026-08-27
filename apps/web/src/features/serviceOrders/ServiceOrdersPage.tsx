import {
  createServiceOrder,
  deriveOrderStatus,
  getSettings,
  hasPermission,
  listCustomerCredits,
  listCustomers,
  listServiceOrderItems,
  listServiceOrders,
  recordCreditRepayment,
  updateServiceOrder,
  updateServiceOrderItem,
  updateServiceOrderItemStatus,
  type ServiceOrderAggregateStatus,
  type ServiceOrderItemStatus,
  type ServiceOrderPaymentMethod,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import {
  buildServiceOrderTicket,
  buildServiceOrderTicketPdf,
  type ServiceOrderTicketData,
} from "@gestion-boutique/printer";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { buildWhatsAppLink } from "../../lib/whatsapp";
import { openExternalUrl } from "../../lib/openExternalUrl";
import { SearchableSelect } from "../../components/SearchableSelect";
import {
  badgeStyle,
  cardStyle,
  inputStyle,
  pageStyle,
  primaryButtonStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "../../components/sharedStyles";
import { useAuth } from "../auth/useAuth";
import { PrinterPanel } from "../printer/PrinterPanel";
import { usePrinter } from "../printer/usePrinter";

type Customer = typeof schema.customers.$inferSelect;
type ServiceOrder = typeof schema.serviceOrders.$inferSelect;
type ServiceOrderItem = typeof schema.serviceOrderItems.$inferSelect;
type Credit = typeof schema.customerCredits.$inferSelect;

interface OrderLine {
  key: number;
  description: string;
  unitPrice: number;
  quantity: number;
  taxRate: number;
}

interface EditableItem {
  id: number;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
}

// Utilisé pour le nom du fichier PDF enregistré — inclut la date ET l'heure
// pour distinguer plusieurs tickets générés le même jour.
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

const ITEM_STATUSES: ServiceOrderItemStatus[] = ["received", "in_progress", "ready", "picked_up"];

export function ServiceOrdersPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const { t } = useTranslation();
  const printer = usePrinter();

  const PAYMENT_METHODS: { value: ServiceOrderPaymentMethod; label: string }[] = [
    { value: "cash", label: t("sales.paymentMethods.cash") },
    { value: "card", label: t("sales.paymentMethods.card") },
    { value: "mobile_money", label: t("sales.paymentMethods.mobile_money") },
    { value: "credit", label: t("sales.paymentMethods.credit") },
  ];

  const ITEM_STATUS_LABELS: Record<ServiceOrderItemStatus, string> = {
    received: t("serviceOrders.itemStatus.received"),
    in_progress: t("serviceOrders.itemStatus.in_progress"),
    ready: t("serviceOrders.itemStatus.ready"),
    picked_up: t("serviceOrders.itemStatus.picked_up"),
  };
  const AGGREGATE_STATUS_LABELS: Record<ServiceOrderAggregateStatus, string> = {
    received: t("serviceOrders.aggregateStatus.received"),
    in_progress: t("serviceOrders.aggregateStatus.in_progress"),
    ready: t("serviceOrders.aggregateStatus.ready"),
    partially_picked_up: t("serviceOrders.aggregateStatus.partially_picked_up"),
    closed: t("serviceOrders.aggregateStatus.closed"),
  };
  const PAYMENT_STATUS_LABELS: Record<string, string> = {
    paid: t("serviceOrders.paymentStatus.paid"),
    partial: t("serviceOrders.paymentStatus.partial"),
    credit: t("serviceOrders.paymentStatus.credit"),
  };

  const [view, setView] = useState<"new" | "track" | "history">("new");
  const [showPrinterPanel, setShowPrinterPanel] = useState(false);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [businessSettings, setBusinessSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(
    null,
  );

  const [lines, setLines] = useState<OrderLine[]>([]);
  const [nextLineKey, setNextLineKey] = useState(1);
  const [customerId, setCustomerId] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [promisedDate, setPromisedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<ServiceOrderPaymentMethod>("cash");
  const [amountPaid, setAmountPaid] = useState("");
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [lastOrderNumber, setLastOrderNumber] = useState<string | null>(null);
  const [lastTicket, setLastTicket] = useState<ServiceOrderTicketData | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);

  const [orders, setOrders] = useState<ServiceOrder[]>([]);
  const [credits, setCredits] = useState<Credit[]>([]);
  const [itemsByOrder, setItemsByOrder] = useState<Record<number, ServiceOrderItem[]>>({});
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);
  const [repayAmount, setRepayAmount] = useState("");
  const [repayError, setRepayError] = useState<string | null>(null);
  const [repaying, setRepaying] = useState(false);

  const [editCustomerId, setEditCustomerId] = useState("");
  const [editPromisedDate, setEditPromisedDate] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editItems, setEditItems] = useState<EditableItem[]>([]);
  const [savingHistory, setSavingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const refreshCatalog = useCallback(async () => {
    const [customersRows, settings] = await Promise.all([listCustomers(db), getSettings(db)]);
    setCustomers(customersRows);
    setBusinessSettings(settings);
  }, [db]);

  useEffect(() => {
    refreshCatalog();
  }, [refreshCatalog]);

  const refreshTrack = useCallback(async () => {
    const storeId = currentStoreId ?? undefined;
    const [orderRows, creditRows] = await Promise.all([
      listServiceOrders(db, { storeId }),
      listCustomerCredits(db, storeId),
    ]);
    setOrders(orderRows);
    setCredits(creditRows);
  }, [db, currentStoreId]);

  useEffect(() => {
    if (view === "track" || view === "history") refreshTrack();
  }, [view, refreshTrack]);

  const addManualLine = () => {
    setLines((prev) => [
      ...prev,
      {
        key: nextLineKey,
        description: "",
        unitPrice: 0,
        quantity: 1,
        taxRate: businessSettings?.taxEnabled ? (businessSettings.defaultTaxRate ?? 0) : 0,
      },
    ]);
    setNextLineKey((k) => k + 1);
  };

  const updateLine = (key: number, patch: Partial<OrderLine>) => {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const removeLine = (key: number) => {
    setLines((prev) => prev.filter((line) => line.key !== key));
  };

  const handlePaymentMethodChange = (method: ServiceOrderPaymentMethod) => {
    setPaymentMethod(method);
    setAmountPaid(method === "credit" ? "0" : "");
  };

  // Prix TTC — voir SalesPage.tsx pour le détail du modèle.
  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  const taxTotal = lines.reduce((sum, l) => {
    const gross = l.quantity * l.unitPrice;
    return sum + (l.taxRate > 0 ? gross * (l.taxRate / (100 + l.taxRate)) : 0);
  }, 0);
  const total = subtotal;

  const paidValuePreview = amountPaid === "" ? total : Number(amountPaid);
  const needsCustomerIdentification = paymentMethod === "credit" || paidValuePreview < total;

  const handleSubmit = async () => {
    setCheckoutError(null);
    if (!user) return;
    if (lines.length === 0) {
      setCheckoutError(t("serviceOrders.errors.itemRequired"));
      return;
    }
    if (lines.some((l) => !l.description.trim())) {
      setCheckoutError(t("serviceOrders.errors.descriptionRequired"));
      return;
    }

    setCheckingOut(true);
    try {
      const paidValue = amountPaid === "" ? total : Number(amountPaid);

      const order = await createServiceOrder(db, {
        userId: user.id,
        customerId: customerId ? Number(customerId) : null,
        newCustomerName: customerId ? undefined : newCustomerName.trim() || undefined,
        newCustomerPhone: customerId ? undefined : newCustomerPhone.trim() || undefined,
        items: lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
        })),
        promisedDate: promisedDate || undefined,
        notes: notes.trim() || undefined,
        paymentMethod,
        amountPaid: paidValue,
        storeId: currentStoreId ?? undefined,
      }, user.permissions);

      const selectedCustomer = customers.find((c) => c.id === Number(customerId));
      const customerName = selectedCustomer?.fullName || newCustomerName.trim() || undefined;
      const customerPhone = selectedCustomer?.phone ?? newCustomerPhone.trim() ?? undefined;

      setLastOrderNumber(order.number);
      setLastTicket({
        businessName: businessSettings?.businessName ?? undefined,
        businessAddress: businessSettings?.address ?? undefined,
        businessPhone: businessSettings?.phone ?? undefined,
        businessEmail: businessSettings?.email ?? undefined,
        logoDataUrl: businessSettings?.logoDataUrl ?? undefined,
        columns: businessSettings?.receiptColumns,
        orderNumber: order.number,
        date: new Date().toLocaleString("fr-FR"),
        customerName,
        customerPhone: customerPhone || undefined,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          total: l.quantity * l.unitPrice,
        })),
        subtotal,
        tax: taxTotal,
        total,
        amountPaid: paidValue,
        promisedDate: promisedDate || undefined,
        showPromisedDate: businessSettings?.printPromisedDateOnTicket ?? true,
      });
      setPrintError(null);
      setLines([]);
      setCustomerId("");
      setNewCustomerName("");
      setNewCustomerPhone("");
      setPromisedDate("");
      setNotes("");
      setAmountPaid("");
      setPaymentMethod("cash");
      await refreshCatalog();
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : t("serviceOrders.errors.saveFailed"));
    } finally {
      setCheckingOut(false);
    }
  };

  const toggleExpand = async (orderId: number) => {
    if (expandedOrderId === orderId) {
      setExpandedOrderId(null);
      return;
    }
    setExpandedOrderId(orderId);
    setRepayAmount("");
    setRepayError(null);
    if (!itemsByOrder[orderId]) {
      const items = await listServiceOrderItems(db, orderId);
      setItemsByOrder((prev) => ({ ...prev, [orderId]: items }));
    }
  };

  const handleStatusChange = async (item: ServiceOrderItem, status: ServiceOrderItemStatus) => {
    if (!user) return;
    await updateServiceOrderItemStatus(db, { itemId: item.id, status, userId: user.id }, user.permissions);
    const items = await listServiceOrderItems(db, item.serviceOrderId);
    setItemsByOrder((prev) => ({ ...prev, [item.serviceOrderId]: items }));
    await refreshTrack();
  };

  const historyToggleExpand = async (order: ServiceOrder) => {
    if (expandedOrderId === order.id) {
      setExpandedOrderId(null);
      return;
    }
    setExpandedOrderId(order.id);
    setHistoryError(null);
    setEditCustomerId(order.customerId ? String(order.customerId) : "");
    setEditPromisedDate(order.promisedDate ?? "");
    setEditNotes(order.notes ?? "");
    const items = itemsByOrder[order.id] ?? (await listServiceOrderItems(db, order.id));
    setItemsByOrder((prev) => ({ ...prev, [order.id]: items }));
    setEditItems(
      items.map((i) => ({
        id: i.id,
        description: i.description,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        taxRate: i.taxRate,
      })),
    );
  };

  const updateEditItem = (id: number, patch: Partial<EditableItem>) => {
    setEditItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const handleSaveHistory = async (orderId: number) => {
    if (!user) return;
    setHistoryError(null);
    if (editItems.some((i) => !i.description.trim())) {
      setHistoryError(t("serviceOrders.errors.historyDescriptionRequired"));
      return;
    }
    setSavingHistory(true);
    try {
      await updateServiceOrder(
        db,
        orderId,
        {
          customerId: editCustomerId ? Number(editCustomerId) : null,
          promisedDate: editPromisedDate || null,
          notes: editNotes.trim() || null,
        },
        user.id,
        user.permissions,
      );
      for (const item of editItems) {
        await updateServiceOrderItem(
          db,
          item.id,
          {
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            taxRate: item.taxRate,
          },
          user.id,
          user.permissions,
        );
      }
      const items = await listServiceOrderItems(db, orderId);
      setItemsByOrder((prev) => ({ ...prev, [orderId]: items }));
      await refreshTrack();
      setExpandedOrderId(null);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : t("serviceOrders.errors.historySaveFailed"));
    } finally {
      setSavingHistory(false);
    }
  };

  const customerName = (id: number | null) => customers.find((c) => c.id === id)?.fullName ?? "—";
  const customerPhone = (id: number | null) => customers.find((c) => c.id === id)?.phone ?? null;
  const creditForOrder = (orderId: number) =>
    credits.find((c) => c.serviceOrderId === orderId && c.status !== "settled");

  const handleRepay = async (credit: Credit) => {
    if (!user) return;
    setRepayError(null);
    const value = Number(repayAmount);
    if (!value || value <= 0) {
      setRepayError(t("serviceOrders.errors.repayAmountPositive"));
      return;
    }
    setRepaying(true);
    try {
      await recordCreditRepayment(db, { creditId: credit.id, amount: value, userId: user.id }, user.permissions);
      setRepayAmount("");
      await refreshTrack();
    } catch (err) {
      setRepayError(err instanceof Error ? err.message : t("serviceOrders.errors.repayFailed"));
    } finally {
      setRepaying(false);
    }
  };

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1>{t("serviceOrders.title")}</h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button
            onClick={() => setView("new")}
            style={{
              ...primaryButtonStyle,
              background: view === "new" ? "var(--gradient-accent)" : "transparent",
              color: view === "new" ? "#0f172a" : "var(--color-text)",
              border: view === "new" ? "none" : "1px solid var(--color-border)",
            }}
          >
            {t("serviceOrders.newTicket")}
          </button>
          <button
            onClick={() => setView("track")}
            style={{
              ...primaryButtonStyle,
              background: view === "track" ? "var(--gradient-accent)" : "transparent",
              color: view === "track" ? "#0f172a" : "var(--color-text)",
              border: view === "track" ? "none" : "1px solid var(--color-border)",
            }}
          >
            {t("serviceOrders.tracking")}
          </button>
          {user && hasPermission(user.permissions, "edit_service_orders") && (
            <button
              onClick={() => setView("history")}
              style={{
                ...primaryButtonStyle,
                background: view === "history" ? "var(--gradient-accent)" : "transparent",
                color: view === "history" ? "#0f172a" : "var(--color-text)",
                border: view === "history" ? "none" : "1px solid var(--color-border)",
              }}
            >
              {t("serviceOrders.history")}
            </button>
          )}
          <button
            onClick={() => setShowPrinterPanel((v) => !v)}
            style={{
              background: "transparent",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
              borderRadius: 8,
              padding: "0 16px",
            }}
          >
            {t("serviceOrders.printer")}
          </button>
        </div>
      </div>

      {showPrinterPanel && <PrinterPanel />}

      {view === "new" && (
        <>
          {lastOrderNumber && (
            <div
              style={{
                ...cardStyle,
                borderLeft: "4px solid var(--color-success)",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <span>
                {t("serviceOrders.registered")} <strong>{lastOrderNumber}</strong>
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button
                  style={primaryButtonStyle}
                  disabled={!printer.connected || !lastTicket}
                  title={!printer.connected ? t("serviceOrders.printerRequiredTooltip") : undefined}
                  onClick={async () => {
                    if (!lastTicket) return;
                    setPrintError(null);
                    try {
                      await printer.print(await buildServiceOrderTicket(lastTicket));
                    } catch (err) {
                      setPrintError(err instanceof Error ? err.message : t("serviceOrders.printError"));
                    }
                  }}
                >
                  {t("serviceOrders.printTicket")}
                </button>
                <button
                  style={{
                    ...primaryButtonStyle,
                    background: "transparent",
                    border: "1px solid var(--color-border)",
                    color: "var(--color-text)",
                  }}
                  disabled={!lastTicket}
                  onClick={() => {
                    if (!lastTicket) return;
                    const blob = buildServiceOrderTicketPdf(lastTicket);
                    downloadBlob(blob, `ticket-${lastOrderNumber}-${timestampForFilename()}.pdf`);
                  }}
                >
                  {t("serviceOrders.saveAsPdf")}
                </button>
              </div>
            </div>
          )}
          {printError && <p style={{ color: "var(--color-danger)" }}>{printError}</p>}

          <div className="cart-layout-grid">
            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <strong>{t("serviceOrders.depositedItems")}</strong>
                <button
                  type="button"
                  style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                  onClick={addManualLine}
                >
                  {t("serviceOrders.addItem")}
                </button>
              </div>
              <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
                {t("serviceOrders.freeEntryHint")}
              </p>

              {lines.length === 0 ? (
                <p style={{ color: "var(--color-text-muted)" }}>{t("serviceOrders.emptyItems")}</p>
              ) : (
                <div className="table-scroll">
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>{t("serviceOrders.description")}</th>
                        <th style={thStyle}>{t("serviceOrders.quantity")}</th>
                        <th style={thStyle}>{t("serviceOrders.unitPrice")}</th>
                        <th style={thStyle}>{t("serviceOrders.total")}</th>
                        <th style={thStyle}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line) => (
                        <tr key={line.key}>
                          <td style={tdStyle}>
                            <input
                              style={{ ...inputStyle, marginTop: 0 }}
                              value={line.description}
                              onChange={(e) => updateLine(line.key, { description: e.target.value })}
                            />
                          </td>
                          <td style={tdStyle}>
                            <input
                              type="number"
                              min={1}
                              value={line.quantity}
                              onChange={(e) => updateLine(line.key, { quantity: Number(e.target.value) })}
                              style={{ ...inputStyle, width: 60, marginTop: 0 }}
                            />
                          </td>
                          <td style={tdStyle}>
                            <input
                              type="number"
                              min={0}
                              value={line.unitPrice}
                              onChange={(e) => updateLine(line.key, { unitPrice: Number(e.target.value) })}
                              style={{ ...inputStyle, width: 90, marginTop: 0 }}
                            />
                          </td>
                          <td style={tdStyle}>{(line.quantity * line.unitPrice).toFixed(0)}</td>
                          <td style={tdStyle}>
                            <button
                              onClick={() => removeLine(line.key)}
                              style={{ background: "transparent", border: "none", color: "var(--color-danger)", cursor: "pointer" }}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <label>
                {t("serviceOrders.promisedDate")}
                <input
                  style={inputStyle}
                  type="date"
                  value={promisedDate}
                  onChange={(e) => setPromisedDate(e.target.value)}
                />
              </label>
              <label>
                {t("serviceOrders.notes")}
                <textarea
                  style={{ ...inputStyle, minHeight: 60 }}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
            </div>

            <div style={cardStyle}>
              <strong>{t("serviceOrders.customerAndPayment")}</strong>
              <div>
                <div>{t("serviceOrders.subtotal")} {subtotal.toFixed(0)}</div>
                <div>{t("serviceOrders.tax")} {taxTotal.toFixed(0)}</div>
                <div style={{ fontWeight: 700, fontSize: 18 }}>{t("serviceOrders.totalLabel")} {total.toFixed(0)}</div>
              </div>

              <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
                {t("serviceOrders.optionalPaidHint")}
              </p>

              <label>
                {t("serviceOrders.registeredCustomer")}
                <SearchableSelect
                  value={customerId}
                  onChange={setCustomerId}
                  options={customers.map((c) => ({ value: String(c.id), label: c.fullName }))}
                  emptyLabel={t("serviceOrders.noCustomerOption")}
                  placeholder={t("serviceOrders.searchCustomerPlaceholder")}
                />
              </label>

              {!customerId && (
                <>
                  <label>
                    {t("serviceOrders.name")}{needsCustomerIdentification ? t("serviceOrders.requiredSuffix") : t("serviceOrders.optionalSuffix")}
                    <input
                      style={{
                        ...inputStyle,
                        border:
                          needsCustomerIdentification && !newCustomerName.trim()
                            ? "1px solid var(--color-danger)"
                            : inputStyle.border,
                      }}
                      value={newCustomerName}
                      onChange={(e) => setNewCustomerName(e.target.value)}
                      placeholder={t("serviceOrders.namePlaceholder")}
                    />
                  </label>
                  <label>
                    {t("serviceOrders.phone")}
                    <input
                      style={inputStyle}
                      value={newCustomerPhone}
                      onChange={(e) => setNewCustomerPhone(e.target.value)}
                      placeholder={t("serviceOrders.phonePlaceholder")}
                    />
                  </label>
                </>
              )}

              <label>
                {t("serviceOrders.paymentMethod")}
                <select
                  style={inputStyle}
                  value={paymentMethod}
                  onChange={(e) => handlePaymentMethodChange(e.target.value as ServiceOrderPaymentMethod)}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                {t("serviceOrders.amountPaid")}
                <input
                  style={inputStyle}
                  type="number"
                  value={amountPaid}
                  onChange={(e) => setAmountPaid(e.target.value)}
                  placeholder={total.toFixed(0)}
                />
              </label>

              {checkoutError && <p style={{ color: "var(--color-danger)" }}>{checkoutError}</p>}

              <button style={primaryButtonStyle} onClick={handleSubmit} disabled={checkingOut}>
                {checkingOut ? t("serviceOrders.saving") : t("serviceOrders.submitAndPrint")}
              </button>
            </div>
          </div>
        </>
      )}

      {view === "track" && (
        <div style={cardStyle}>
          <div className="table-scroll">
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("serviceOrders.ticket")}</th>
                  <th style={thStyle}>{t("serviceOrders.customer")}</th>
                  <th style={thStyle}>{t("serviceOrders.status")}</th>
                  <th style={thStyle}>{t("serviceOrders.payment")}</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const items = itemsByOrder[order.id] ?? [];
                  const summary = deriveOrderStatus(items);
                  const credit = creditForOrder(order.id);
                  const expanded = expandedOrderId === order.id;

                  return (
                    <Fragment key={order.id}>
                      <tr>
                        <td style={tdStyle}>{order.number}</td>
                        <td style={tdStyle}>{customerName(order.customerId)}</td>
                        <td style={tdStyle}>
                          {expanded
                            ? `${AGGREGATE_STATUS_LABELS[summary.status]} (${summary.pickedUpCount}/${summary.totalCount})`
                            : order.closedAt
                              ? t("serviceOrders.closedStatus")
                              : "—"}
                        </td>
                        <td style={tdStyle}>
                          <span style={badgeStyle(order.paymentStatus === "paid" ? "ok" : "warning")}>
                            {PAYMENT_STATUS_LABELS[order.paymentStatus] ?? order.paymentStatus}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          <button
                            style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                            onClick={() => toggleExpand(order.id)}
                          >
                            {expanded ? t("serviceOrders.close") : t("serviceOrders.detail")}
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td style={tdStyle} colSpan={5}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                              {items.map((item) => (
                                <div
                                  key={item.id}
                                  style={{ display: "flex", alignItems: "center", gap: 12 }}
                                >
                                  <span style={{ flex: 1 }}>
                                    {item.quantity} x {item.description || t("serviceOrders.itemFallback")}
                                  </span>
                                  <select
                                    style={{ ...inputStyle, width: 160, marginTop: 0 }}
                                    value={item.status}
                                    onChange={(e) =>
                                      handleStatusChange(item, e.target.value as ServiceOrderItemStatus)
                                    }
                                  >
                                    {ITEM_STATUSES.map((s) => (
                                      <option key={s} value={s}>
                                        {ITEM_STATUS_LABELS[s]}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              ))}

                              {summary.status === "ready" && customerPhone(order.customerId) && (
                                <button
                                  style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14, alignSelf: "flex-start" }}
                                  onClick={() => {
                                    const phone = customerPhone(order.customerId)!;
                                    const message = t("whatsapp.serviceOrderReady", {
                                      customerName: customerName(order.customerId),
                                      orderNumber: order.number,
                                      business: businessSettings?.businessName ?? t("whatsapp.defaultBusinessName"),
                                    });
                                    void openExternalUrl(
                                      buildWhatsAppLink(phone, businessSettings?.whatsappCountryCode, message),
                                    );
                                  }}
                                >
                                  {t("serviceOrders.notifyWhatsapp")}
                                </button>
                              )}

                              {order.notes && (
                                <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{t("serviceOrders.notesLabel")} {order.notes}</p>
                              )}
                              {order.promisedDate && (
                                <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
                                  {t("serviceOrders.promisedPickup")} {order.promisedDate}
                                </p>
                              )}

                              {credit && (
                                <div
                                  style={{
                                    borderTop: "1px solid var(--color-border)",
                                    paddingTop: 12,
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    flexWrap: "wrap",
                                  }}
                                >
                                  <span>{t("serviceOrders.remainingBalance")} {credit.remainingBalance.toFixed(0)}</span>
                                  <input
                                    type="number"
                                    style={{ ...inputStyle, width: 90, marginTop: 0 }}
                                    value={repayAmount}
                                    onChange={(e) => setRepayAmount(e.target.value)}
                                    placeholder={credit.remainingBalance.toFixed(0)}
                                  />
                                  <button
                                    style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                                    onClick={() => handleRepay(credit)}
                                    disabled={repaying}
                                  >
                                    {t("serviceOrders.collectBalance")}
                                  </button>
                                </div>
                              )}
                              {repayError && <p style={{ color: "var(--color-danger)" }}>{repayError}</p>}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {orders.length === 0 && (
                  <tr>
                    <td style={tdStyle} colSpan={5}>
                      {t("serviceOrders.noTickets")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view === "history" && (
        <div style={cardStyle}>
          <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
            {t("serviceOrders.historyHint")}
          </p>
          <div className="table-scroll">
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("serviceOrders.ticket")}</th>
                  <th style={thStyle}>{t("serviceOrders.customer")}</th>
                  <th style={thStyle}>{t("serviceOrders.total")}</th>
                  <th style={thStyle}>{t("serviceOrders.payment")}</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const expanded = expandedOrderId === order.id;

                  return (
                    <Fragment key={order.id}>
                      <tr>
                        <td style={tdStyle}>{order.number}</td>
                        <td style={tdStyle}>{customerName(order.customerId)}</td>
                        <td style={tdStyle}>{order.total.toFixed(0)}</td>
                        <td style={tdStyle}>
                          <span style={badgeStyle(order.paymentStatus === "paid" ? "ok" : "warning")}>
                            {PAYMENT_STATUS_LABELS[order.paymentStatus] ?? order.paymentStatus}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          <button
                            style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                            onClick={() => historyToggleExpand(order)}
                          >
                            {expanded ? t("serviceOrders.close") : t("serviceOrders.correct")}
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td style={tdStyle} colSpan={5}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                              <label>
                                {t("serviceOrders.customer")}
                                <SearchableSelect
                                  value={editCustomerId}
                                  onChange={setEditCustomerId}
                                  options={customers.map((c) => ({ value: String(c.id), label: c.fullName }))}
                                  emptyLabel={t("serviceOrders.noCustomerEditOption")}
                                  placeholder={t("serviceOrders.searchCustomerPlaceholder")}
                                />
                              </label>
                              <label>
                                {t("serviceOrders.promisedDate")}
                                <input
                                  style={inputStyle}
                                  type="date"
                                  value={editPromisedDate}
                                  onChange={(e) => setEditPromisedDate(e.target.value)}
                                />
                              </label>
                              <label>
                                {t("serviceOrders.notes")}
                                <textarea
                                  style={{ ...inputStyle, minHeight: 60 }}
                                  value={editNotes}
                                  onChange={(e) => setEditNotes(e.target.value)}
                                />
                              </label>

                              <div className="table-scroll">
                                <table style={tableStyle}>
                                  <thead>
                                    <tr>
                                      <th style={thStyle}>{t("serviceOrders.description")}</th>
                                      <th style={thStyle}>{t("serviceOrders.quantity")}</th>
                                      <th style={thStyle}>{t("serviceOrders.unitPrice")}</th>
                                      <th style={thStyle}>{t("serviceOrders.taxRatePercent")}</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {editItems.map((item) => (
                                      <tr key={item.id}>
                                        <td style={tdStyle}>
                                          <input
                                            style={{ ...inputStyle, marginTop: 0 }}
                                            value={item.description}
                                            onChange={(e) =>
                                              updateEditItem(item.id, { description: e.target.value })
                                            }
                                          />
                                        </td>
                                        <td style={tdStyle}>
                                          <input
                                            type="number"
                                            min={1}
                                            value={item.quantity}
                                            onChange={(e) =>
                                              updateEditItem(item.id, { quantity: Number(e.target.value) })
                                            }
                                            style={{ ...inputStyle, width: 60, marginTop: 0 }}
                                          />
                                        </td>
                                        <td style={tdStyle}>
                                          <input
                                            type="number"
                                            min={0}
                                            value={item.unitPrice}
                                            onChange={(e) =>
                                              updateEditItem(item.id, { unitPrice: Number(e.target.value) })
                                            }
                                            style={{ ...inputStyle, width: 90, marginTop: 0 }}
                                          />
                                        </td>
                                        <td style={tdStyle}>
                                          <input
                                            type="number"
                                            min={0}
                                            value={item.taxRate}
                                            onChange={(e) =>
                                              updateEditItem(item.id, { taxRate: Number(e.target.value) })
                                            }
                                            style={{ ...inputStyle, width: 70, marginTop: 0 }}
                                          />
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>

                              {historyError && <p style={{ color: "var(--color-danger)" }}>{historyError}</p>}

                              <button
                                style={primaryButtonStyle}
                                onClick={() => handleSaveHistory(order.id)}
                                disabled={savingHistory}
                              >
                                {savingHistory ? t("serviceOrders.saving") : t("serviceOrders.save")}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {orders.length === 0 && (
                  <tr>
                    <td style={tdStyle} colSpan={5}>
                      {t("serviceOrders.noTickets")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
