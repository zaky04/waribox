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

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Espèces" },
  { value: "card", label: "Carte" },
  { value: "mobile_money", label: "Mobile Money" },
  { value: "credit", label: "Crédit" },
];

const STATUS_LABELS: Record<string, string> = {
  pending: "En attente",
  accepted: "Accepté",
  expired: "Expiré",
  converted: "Converti",
};

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
  const { user } = useAuth();
  const canManage = hasPermission(user?.permissions ?? {}, "manage_quotes");
  const canEdit = hasPermission(user?.permissions ?? {}, "edit_quotes");

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
      listLocations(db),
      getSettings(db),
      listQuotes(db),
    ]);
    setProducts(productsRows);
    setVariants(variantsRows);
    setCustomers(customersRows);
    setBusinessSettings(settings);
    setQuotes(quoteRows);
    const surface = locations.find((l) => l.type === "surface_vente");
    setSurfaceLocationId(surface?.id ?? null);
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
          taxRate: product.taxRate ?? 0,
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

  const subtotal = cart.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const taxTotal = cart.reduce((sum, line) => sum + line.quantity * line.unitPrice * (line.taxRate / 100), 0);
  const total = subtotal + taxTotal;

  const customerName = (id: number | null) => customers.find((c) => c.id === id)?.fullName ?? "—";

  const handleCreateQuote = async () => {
    setError(null);
    if (cart.length === 0) {
      setError("Le devis doit contenir au moins un article.");
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
      });
      setCart([]);
      setCustomerId("");
      setNewCustomerName("");
      setValidUntil("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible d'enregistrer le devis.");
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
      tax: items.reduce((sum, i) => sum + i.quantity * i.unitPrice * (i.taxRate / 100), 0),
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
    if (!user || !surfaceLocationId) return;
    setConverting(true);
    try {
      await convertQuoteToSale(db, quote.id, {
        surfaceLocationId,
        paymentMethod: convertPaymentMethod,
        amountPaid: convertAmountPaid === "" ? undefined : Number(convertAmountPaid),
        userId: user.id,
      });
      setExpandedQuoteId(null);
      await refresh();
    } catch (err) {
      setConvertError(err instanceof Error ? err.message : "Impossible de convertir ce devis en vente.");
    } finally {
      setConverting(false);
    }
  };

  const handleStatusChange = async (quote: Quote, status: "accepted" | "expired") => {
    if (!user) return;
    await updateQuoteStatus(db, quote.id, status, user.id);
    await refresh();
  };

  return (
    <main style={pageStyle}>
      <h1>Devis</h1>

      {canManage && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 24, marginTop: 24 }}>
          <div style={cardStyle}>
            <strong>Ajouter des articles</strong>
            <SearchableSelect
              value=""
              onChange={(id) => {
                const product = products.find((p) => p.id === Number(id));
                if (product) addToCart(product);
              }}
              options={products.map((p) => ({ value: String(p.id), label: p.name }))}
              emptyLabel="— Choisir un produit —"
              placeholder="Rechercher un produit..."
            />

            {cart.length === 0 ? (
              <p style={{ color: "var(--color-text-muted)" }}>Aucun article.</p>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Article</th>
                    <th style={thStyle}>Qté</th>
                    <th style={thStyle}>Total</th>
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
                          style={{ background: "transparent", border: "none", color: "#f87171", cursor: "pointer" }}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div style={cardStyle}>
            <strong>Client & validité</strong>
            <div>
              <div>Sous-total : {subtotal.toFixed(0)}</div>
              <div>Taxe : {taxTotal.toFixed(0)}</div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>Total : {total.toFixed(0)}</div>
            </div>

            <label>
              Client déjà enregistré
              <SearchableSelect
                value={customerId}
                onChange={setCustomerId}
                options={customers.map((c) => ({ value: String(c.id), label: c.fullName }))}
                emptyLabel="— Aucun / nouveau —"
                placeholder="Rechercher un client..."
              />
            </label>

            {!customerId && (
              <label>
                Ou nom du client (optionnel)
                <input
                  style={inputStyle}
                  value={newCustomerName}
                  onChange={(e) => setNewCustomerName(e.target.value)}
                  placeholder="Nom du client"
                />
              </label>
            )}

            <label>
              Valable jusqu'au (optionnel)
              <input
                style={inputStyle}
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </label>

            {error && <p style={{ color: "#f87171" }}>{error}</p>}

            <button style={primaryButtonStyle} onClick={handleCreateQuote} disabled={saving}>
              {saving ? "Enregistrement..." : "Enregistrer le devis"}
            </button>
          </div>
        </div>
      )}

      <div style={cardStyle}>
        <strong>Devis enregistrés</strong>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Devis</th>
              <th style={thStyle}>Client</th>
              <th style={thStyle}>Total</th>
              <th style={thStyle}>Statut</th>
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
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                          onClick={() => handleDownloadPdf(quote)}
                        >
                          PDF
                        </button>
                        {canEdit && quote.status === "pending" && (
                          <>
                            <button
                              style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                              onClick={() => handleStatusChange(quote, "accepted")}
                            >
                              Accepter
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
                              Marquer expiré
                            </button>
                          </>
                        )}
                        {canManage && quote.status !== "converted" && (
                          <button
                            style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                            onClick={() => toggleConvert(quote)}
                          >
                            {expanded ? "Fermer" : "Convertir en vente"}
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
                            Méthode de paiement
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
                            Montant payé (laisser vide = total)
                            <input
                              style={inputStyle}
                              type="number"
                              value={convertAmountPaid}
                              onChange={(e) => setConvertAmountPaid(e.target.value)}
                              placeholder={quote.total.toFixed(0)}
                            />
                          </label>
                          {convertError && <p style={{ color: "#f87171" }}>{convertError}</p>}
                          <button
                            style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}
                            onClick={() => handleConvert(quote)}
                            disabled={converting}
                          >
                            {converting ? "Conversion..." : "Confirmer la conversion"}
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
                  Aucun devis pour le moment.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
