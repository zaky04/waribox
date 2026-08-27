import {
  convertQuoteToSale,
  createQuote,
  getSettings,
  hasPermission,
  listAllVariants,
  listCustomers,
  listLocations,
  listProducts,
  listQuoteItems,
  listQuotes,
  updateQuoteStatus,
  type PaymentMethod,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { buildQuotePdf } from "@gestion-boutique/printer";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
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

type Product = typeof schema.products.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;
type Customer = typeof schema.customers.$inferSelect;
type Quote = typeof schema.quotes.$inferSelect;

interface CartLine {
  variantId: number;
  productName: string;
  unitPrice: number;
  quantity: number;
  taxRate: number;
}

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

export function QuotesPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const { t } = useTranslation();
  const canManage = hasPermission(user?.permissions ?? {}, "manage_quotes");
  const canEdit = hasPermission(user?.permissions ?? {}, "edit_quotes");

  const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
    { value: "cash", label: t("sales.paymentMethods.cash") },
    { value: "card", label: t("sales.paymentMethods.card") },
    { value: "mobile_money", label: t("sales.paymentMethods.mobile_money") },
    { value: "credit", label: t("sales.paymentMethods.credit") },
  ];

  const STATUS_LABELS: Record<string, string> = {
    pending: t("quotes.status.pending"),
    accepted: t("quotes.status.accepted"),
    expired: t("quotes.status.expired"),
    converted: t("quotes.status.converted"),
  };

  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [surfaceLocationId, setSurfaceLocationId] = useState<number | null>(null);
  const [businessSettings, setBusinessSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(
    null,
  );
  const [quotes, setQuotes] = useState<Quote[]>([]);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [expandedQuoteId, setExpandedQuoteId] = useState<number | null>(null);
  const [convertPaymentMethod, setConvertPaymentMethod] = useState<PaymentMethod>("cash");
  const [convertAmountPaid, setConvertAmountPaid] = useState("");
  const [convertError, setConvertError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);

  const refresh = useCallback(async () => {
    const [productsRows, variantsRows, customersRows, locations, settings, quoteRows] = await Promise.all([
      listProducts(db),
      listAllVariants(db),
      listCustomers(db),
      listLocations(db, currentStoreId ?? undefined),
      getSettings(db),
      listQuotes(db, currentStoreId ?? undefined),
    ]);
    setProducts(productsRows);
    setVariants(variantsRows);
    setCustomers(customersRows);
    setBusinessSettings(settings);
    setQuotes(quoteRows);
    const surface = locations.find((l) => l.type === "surface_vente" || l.type.startsWith("surface_vente#"));
    setSurfaceLocationId(surface?.id ?? null);
  }, [db, currentStoreId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Voir SalesPage.resolveTaxRate — même logique (TVA désactivée -> 0, sinon
  // taux du produit ou, à défaut, taux par défaut de l'entreprise).
  const resolveTaxRate = (product: Product) =>
    businessSettings?.taxEnabled ? (product.taxRate ?? businessSettings.defaultTaxRate ?? 0) : 0;

  const addToCart = (product: Product) => {
    const variant = variants.find((v) => v.productId === product.id);
    if (!variant) return;
    setCart((prev) => {
      const existing = prev.find((line) => line.variantId === variant.id);
      if (existing) {
        return prev.map((line) =>
          line.variantId === variant.id ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [
        ...prev,
        {
          variantId: variant.id,
          productName: product.name,
          unitPrice: variant.priceOverride ?? product.salePrice,
          quantity: 1,
          taxRate: resolveTaxRate(product),
        },
      ];
    });
  };

  const updateQuantity = (variantId: number, quantity: number) => {
    setCart((prev) =>
      quantity <= 0
        ? prev.filter((line) => line.variantId !== variantId)
        : prev.map((line) => (line.variantId === variantId ? { ...line, quantity } : line)),
    );
  };

  const removeLine = (variantId: number) => {
    setCart((prev) => prev.filter((line) => line.variantId !== variantId));
  };

  // Prix TTC — voir SalesPage.tsx pour le détail du modèle.
  const subtotal = cart.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const taxTotal = cart.reduce((sum, line) => {
    const gross = line.quantity * line.unitPrice;
    return sum + (line.taxRate > 0 ? gross * (line.taxRate / (100 + line.taxRate)) : 0);
  }, 0);
  const total = subtotal;

  const customerName = (id: number | null) => customers.find((c) => c.id === id)?.fullName ?? "—";

  const handleCreateQuote = async () => {
    setError(null);
    if (cart.length === 0) {
      setError(t("quotes.errors.itemRequired"));
      return;
    }
    setSaving(true);
    try {
      await createQuote(db, {
        customerId: customerId ? Number(customerId) : null,
        newCustomerName: customerId ? undefined : newCustomerName.trim() || undefined,
        items: cart.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          taxRate: line.taxRate,
        })),
        validUntil: validUntil || undefined,
        createdBy: user?.id,
        storeId: currentStoreId ?? undefined,
      }, user?.permissions ?? {});
      setCart([]);
      setCustomerId("");
      setNewCustomerName("");
      setValidUntil("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("quotes.errors.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadPdf = async (quote: Quote) => {
    const items = await listQuoteItems(db, quote.id);
    const blob = buildQuotePdf({
      businessName: businessSettings?.businessName ?? undefined,
      businessAddress: businessSettings?.address ?? undefined,
      businessPhone: businessSettings?.phone ?? undefined,
      businessEmail: businessSettings?.email ?? undefined,
      quoteNumber: quote.number,
      date: quote.createdAt,
      validUntil: quote.validUntil ?? undefined,
      customerName: quote.customerId ? customerName(quote.customerId) : undefined,
      lines: items.map((item) => {
        const variant = variants.find((v) => v.id === item.variantId);
        const product = products.find((p) => p.id === variant?.productId);
        return {
          description: product?.name ?? "Article",
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          total: item.total,
        };
      }),
      subtotal: items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0),
      tax: items.reduce((sum, i) => {
        const gross = i.quantity * i.unitPrice;
        return sum + (i.taxRate > 0 ? gross * (i.taxRate / (100 + i.taxRate)) : 0);
      }, 0),
      total: quote.total,
    });
    downloadBlob(blob, `devis-${quote.number}-${timestampForFilename()}.pdf`);
  };

  const toggleConvert = (quote: Quote) => {
    if (expandedQuoteId === quote.id) {
      setExpandedQuoteId(null);
      return;
    }
    setExpandedQuoteId(quote.id);
    setConvertPaymentMethod("cash");
    setConvertAmountPaid("");
    setConvertError(null);
  };

  const handleConvert = async (quote: Quote) => {
    setConvertError(null);
    if (!user || !surfaceLocationId || !currentStoreId) return;
    setConverting(true);
    try {
      await convertQuoteToSale(db, quote.id, {
        surfaceLocationId,
        paymentMethod: convertPaymentMethod,
        amountPaid: convertAmountPaid === "" ? undefined : Number(convertAmountPaid),
        userId: user.id,
        storeId: currentStoreId,
      }, user.permissions);
      setExpandedQuoteId(null);
      await refresh();
    } catch (err) {
      setConvertError(err instanceof Error ? err.message : t("quotes.errors.convertFailed"));
    } finally {
      setConverting(false);
    }
  };

  const handleStatusChange = async (quote: Quote, status: "accepted" | "expired") => {
    if (!user) return;
    await updateQuoteStatus(db, quote.id, status, user.id, user.permissions);
    await refresh();
  };

  return (
    <main style={pageStyle}>
      <h1>{t("quotes.title")}</h1>

      {canManage && (
        <div className="cart-layout-grid">
          <div style={cardStyle}>
            <strong>{t("quotes.addItems")}</strong>
            <SearchableSelect
              value=""
              onChange={(id) => {
                const product = products.find((p) => p.id === Number(id));
                if (product) addToCart(product);
              }}
              options={products.map((p) => ({ value: String(p.id), label: p.name }))}
              emptyLabel={t("quotes.chooseProduct")}
              placeholder={t("quotes.searchProductPlaceholder")}
            />

            {cart.length === 0 ? (
              <p style={{ color: "var(--color-text-muted)" }}>{t("quotes.emptyCart")}</p>
            ) : (
              <div className="table-scroll">
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>{t("quotes.item")}</th>
                      <th style={thStyle}>{t("quotes.quantity")}</th>
                      <th style={thStyle}>{t("quotes.total")}</th>
                      <th style={thStyle}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {cart.map((line) => (
                      <tr key={line.variantId}>
                        <td style={tdStyle}>{line.productName}</td>
                        <td style={tdStyle}>
                          <input
                            type="number"
                            value={line.quantity}
                            onChange={(e) => updateQuantity(line.variantId, Number(e.target.value))}
                            style={{ ...inputStyle, width: 60, marginTop: 0 }}
                          />
                        </td>
                        <td style={tdStyle}>{(line.quantity * line.unitPrice).toFixed(0)}</td>
                        <td style={tdStyle}>
                          <button
                            onClick={() => removeLine(line.variantId)}
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
          </div>

          <div style={cardStyle}>
            <strong>{t("quotes.customerAndValidity")}</strong>
            <div>
              <div>{t("quotes.subtotal")} {subtotal.toFixed(0)}</div>
              <div>{t("quotes.tax")} {taxTotal.toFixed(0)}</div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>{t("quotes.totalLabel")} {total.toFixed(0)}</div>
            </div>

            <label>
              {t("quotes.registeredCustomer")}
              <SearchableSelect
                value={customerId}
                onChange={setCustomerId}
                options={customers.map((c) => ({ value: String(c.id), label: c.fullName }))}
                emptyLabel={t("quotes.noCustomerOption")}
                placeholder={t("quotes.searchCustomerPlaceholder")}
              />
            </label>

            {!customerId && (
              <label>
                {t("quotes.orCustomerName")}
                <input
                  style={inputStyle}
                  value={newCustomerName}
                  onChange={(e) => setNewCustomerName(e.target.value)}
                  placeholder={t("quotes.customerNamePlaceholder")}
                />
              </label>
            )}

            <label>
              {t("quotes.validUntil")}
              <input
                style={inputStyle}
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </label>

            {error && <p style={{ color: "var(--color-danger)" }}>{error}</p>}

            <button style={primaryButtonStyle} onClick={handleCreateQuote} disabled={saving}>
              {saving ? t("quotes.saving") : t("quotes.submit")}
            </button>
          </div>
        </div>
      )}

      <div style={cardStyle}>
        <strong>{t("quotes.savedQuotes")}</strong>
        <div className="table-scroll">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t("quotes.quoteColumn")}</th>
                <th style={thStyle}>{t("quotes.customer")}</th>
                <th style={thStyle}>{t("quotes.total")}</th>
                <th style={thStyle}>{t("quotes.statusColumn")}</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((quote) => {
                const expanded = expandedQuoteId === quote.id;
                return (
                  <Fragment key={quote.id}>
                    <tr>
                      <td style={tdStyle}>{quote.number}</td>
                      <td style={tdStyle}>{customerName(quote.customerId)}</td>
                      <td style={tdStyle}>{quote.total.toFixed(0)}</td>
                      <td style={tdStyle}>
                        <span style={badgeStyle(quote.status === "converted" || quote.status === "accepted" ? "ok" : "warning")}>
                          {STATUS_LABELS[quote.status] ?? quote.status}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          <button
                            style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                            onClick={() => handleDownloadPdf(quote)}
                          >
                            {t("quotes.pdf")}
                          </button>
                          {canEdit && quote.status === "pending" && (
                            <>
                              <button
                                style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                                onClick={() => handleStatusChange(quote, "accepted")}
                              >
                                {t("quotes.accept")}
                              </button>
                              <button
                                style={{
                                  ...primaryButtonStyle,
                                  padding: "6px 12px",
                                  fontSize: 14,
                                  background: "transparent",
                                  border: "1px solid var(--color-border)",
                                  color: "var(--color-text)",
                                }}
                                onClick={() => handleStatusChange(quote, "expired")}
                              >
                                {t("quotes.markExpired")}
                              </button>
                            </>
                          )}
                          {canManage && quote.status !== "converted" && (
                            <button
                              style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                              onClick={() => toggleConvert(quote)}
                            >
                              {expanded ? t("quotes.close") : t("quotes.convertToSale")}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td style={tdStyle} colSpan={5}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            <label>
                              {t("quotes.paymentMethod")}
                              <select
                                style={inputStyle}
                                value={convertPaymentMethod}
                                onChange={(e) => setConvertPaymentMethod(e.target.value as PaymentMethod)}
                              >
                                {PAYMENT_METHODS.map((m) => (
                                  <option key={m.value} value={m.value}>
                                    {m.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              {t("quotes.amountPaid")}
                              <input
                                style={inputStyle}
                                type="number"
                                value={convertAmountPaid}
                                onChange={(e) => setConvertAmountPaid(e.target.value)}
                                placeholder={quote.total.toFixed(0)}
                              />
                            </label>
                            {convertError && <p style={{ color: "var(--color-danger)" }}>{convertError}</p>}
                            <button
                              style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}
                              onClick={() => handleConvert(quote)}
                              disabled={converting}
                            >
                              {converting ? t("quotes.converting") : t("quotes.confirmConversion")}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {quotes.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={5}>
                    {t("quotes.none")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
