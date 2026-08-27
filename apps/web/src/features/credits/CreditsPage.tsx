import {
  getSettings,
  isCreditOverdue,
  listAllVariants,
  listCustomers,
  listCustomerCredits,
  listProducts,
  listSales,
  listServiceOrders,
  recordCreditRepayment,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import {
  badgeStyle,
  inputStyle,
  pageStyle,
  primaryButtonStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "../../components/sharedStyles";
import { openExternalUrl } from "../../lib/openExternalUrl";
import { buildWhatsAppLink } from "../../lib/whatsapp";
import { useAuth } from "../auth/useAuth";

type Credit = typeof schema.customerCredits.$inferSelect;
type Customer = typeof schema.customers.$inferSelect;
type Sale = typeof schema.sales.$inferSelect;
type ServiceOrder = typeof schema.serviceOrders.$inferSelect;
type SaleItem = typeof schema.saleItems.$inferSelect;
type ServiceOrderItem = typeof schema.serviceOrderItems.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;
type Product = typeof schema.products.$inferSelect;

export function CreditsPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const { t } = useTranslation();

  const STATUS_LABELS: Record<string, string> = {
    open: t("common.debtCreditStatus.open"),
    partial: t("common.debtCreditStatus.partial"),
    settled: t("common.debtCreditStatus.settled"),
  };

  const [credits, setCredits] = useState<Credit[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [serviceOrders, setServiceOrders] = useState<ServiceOrder[]>([]);
  const [saleItems, setSaleItems] = useState<SaleItem[]>([]);
  const [serviceOrderItems, setServiceOrderItems] = useState<ServiceOrderItem[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [showSettled, setShowSettled] = useState(false);
  const [businessSettings, setBusinessSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(null);

  const [payingId, setPayingId] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [
      creditRows,
      customerRows,
      saleRows,
      serviceOrderRows,
      saleItemRows,
      serviceOrderItemRows,
      variantRows,
      productRows,
      settings,
    ] = await Promise.all([
      listCustomerCredits(db, currentStoreId ?? undefined),
      listCustomers(db),
      listSales(db),
      listServiceOrders(db),
      db.select().from(schema.saleItems),
      db.select().from(schema.serviceOrderItems),
      listAllVariants(db),
      listProducts(db),
      getSettings(db),
    ]);
    setCredits(creditRows);
    setCustomers(customerRows);
    setSales(saleRows);
    setServiceOrders(serviceOrderRows);
    setSaleItems(saleItemRows);
    setServiceOrderItems(serviceOrderItemRows);
    setVariants(variantRows);
    setProducts(productRows);
    setBusinessSettings(settings);
  }, [db, currentStoreId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const customerName = (id: number) => customers.find((c) => c.id === id)?.fullName ?? "—";
  const customerPhone = (id: number) => customers.find((c) => c.id === id)?.phone ?? null;
  const referenceNumber = (credit: Credit) =>
    sales.find((s) => s.id === credit.saleId)?.number ??
    serviceOrders.find((o) => o.id === credit.serviceOrderId)?.number ??
    "—";

  const articleSummary = (credit: Credit) => {
    if (credit.saleId) {
      const names = saleItems
        .filter((i) => i.saleId === credit.saleId)
        .map((i) => {
          const variant = variants.find((v) => v.id === i.variantId);
          const product = variant ? products.find((p) => p.id === variant.productId) : undefined;
          return product?.name ?? "Article";
        });
      return names.length > 0 ? names.join(", ") : "—";
    }
    if (credit.serviceOrderId) {
      const names = serviceOrderItems
        .filter((i) => i.serviceOrderId === credit.serviceOrderId)
        .map((i) => i.description);
      return names.length > 0 ? names.join(", ") : "—";
    }
    return "—";
  };

  const visibleCredits = credits.filter((c) => showSettled || c.status !== "settled");

  const handleNotifyOverdue = (credit: Credit) => {
    const phone = customerPhone(credit.customerId);
    if (!phone) return;
    const message = t("whatsapp.overdueDebt", {
      customerName: customerName(credit.customerId),
      amount: credit.remainingBalance,
      dueDate: credit.dueDate,
      business: businessSettings?.businessName ?? t("whatsapp.defaultBusinessName"),
      reference: referenceNumber(credit),
    });
    void openExternalUrl(buildWhatsAppLink(phone, businessSettings?.whatsappCountryCode, message));
  };

  const startPayment = (credit: Credit) => {
    setPayingId(credit.id);
    setAmount(String(credit.remainingBalance));
    setError(null);
  };

  const handleSubmit = async (credit: Credit) => {
    setError(null);
    if (!user) return;
    const value = Number(amount);
    if (!value || value <= 0) {
      setError(t("credits.errors.amountPositive"));
      return;
    }

    setSaving(true);
    try {
      await recordCreditRepayment(db, { creditId: credit.id, amount: value, userId: user.id }, user.permissions);
      setPayingId(null);
      setAmount("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("credits.errors.paymentFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1>{t("credits.title")}</h1>
        <button
          style={{
            ...primaryButtonStyle,
            background: showSettled ? "var(--gradient-accent)" : "transparent",
            color: showSettled ? "#0f172a" : "var(--color-text)",
            border: showSettled ? "none" : "1px solid var(--color-border)",
          }}
          onClick={() => setShowSettled((v) => !v)}
        >
          {showSettled ? t("credits.hideSettled") : t("credits.showSettled")}
        </button>
      </div>

      <div className="table-scroll">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>{t("credits.date")}</th>
              <th style={thStyle}>{t("credits.customer")}</th>
              <th style={thStyle}>{t("credits.reference")}</th>
              <th style={thStyle}>{t("credits.article")}</th>
              <th style={thStyle}>{t("credits.originalAmount")}</th>
              <th style={thStyle}>{t("credits.remainingBalance")}</th>
              <th style={thStyle}>{t("credits.dueDate")}</th>
              <th style={thStyle}>{t("credits.status")}</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {visibleCredits.map((credit) => {
              const overdue = isCreditOverdue(credit);
              const phone = customerPhone(credit.customerId);
              return (
                <tr key={credit.id}>
                  <td style={tdStyle}>{credit.createdAt}</td>
                  <td style={tdStyle}>{customerName(credit.customerId)}</td>
                  <td style={tdStyle}>{referenceNumber(credit)}</td>
                  <td style={tdStyle}>{articleSummary(credit)}</td>
                  <td style={tdStyle}>{credit.originalAmount}</td>
                  <td style={tdStyle}>{credit.remainingBalance}</td>
                  <td style={tdStyle}>{credit.dueDate ?? "—"}</td>
                  <td style={tdStyle}>
                    <span style={badgeStyle(credit.status === "settled" ? "ok" : overdue ? "danger" : "warning")}>
                      {overdue ? t("credits.overdue") : STATUS_LABELS[credit.status] ?? credit.status}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {credit.status !== "settled" &&
                        (payingId === credit.id ? (
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <input
                              type="number"
                              style={{ ...inputStyle, width: 90, marginTop: 0 }}
                              value={amount}
                              onChange={(e) => setAmount(e.target.value)}
                            />
                            <button
                              style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                              onClick={() => handleSubmit(credit)}
                              disabled={saving}
                            >
                              {t("credits.confirm")}
                            </button>
                            <button
                              style={{ background: "transparent", border: "none", color: "var(--color-text-muted)", cursor: "pointer" }}
                              onClick={() => setPayingId(null)}
                            >
                              {t("credits.cancel")}
                            </button>
                          </div>
                        ) : (
                          <button
                            style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                            onClick={() => startPayment(credit)}
                          >
                            {t("credits.recordPayment")}
                          </button>
                        ))}
                      {overdue && phone && (
                        <button
                          style={{
                            padding: "6px 12px",
                            fontSize: 14,
                            borderRadius: 8,
                            border: "1px solid var(--color-border)",
                            background: "transparent",
                            color: "var(--color-text)",
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                          onClick={() => handleNotifyOverdue(credit)}
                        >
                          {t("credits.notifyWhatsapp")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {visibleCredits.length === 0 && (
              <tr>
                <td style={tdStyle} colSpan={9}>
                  {t("credits.none")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {error && <p style={{ color: "var(--color-danger)" }}>{error}</p>}
    </main>
  );
}
