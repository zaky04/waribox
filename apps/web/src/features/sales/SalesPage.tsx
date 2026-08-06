import {
  createSale,
  getExpectedCashAmount,
  getSettings,
  listCustomers,
  listLocations,
  listProducts,
  listAllVariants,
  pointsToDiscount,
  type PaymentMethod,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { buildReceipt, buildReceiptPdf, type ReceiptData } from "@gestion-boutique/printer";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDatabase } from "../../app/DatabaseProvider";
import { SearchableSelect } from "../../components/SearchableSelect";
import {
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
import { CloseCashSessionPanel } from "./CloseCashSessionPanel";
import { OpenCashSessionScreen } from "./OpenCashSessionScreen";
import { useBarcodeScanner } from "./useBarcodeScanner";
import { useCashSession } from "./useCashSession";

type Product = typeof schema.products.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;
type Customer = typeof schema.customers.$inferSelect;

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

// Utilisé pour le nom du fichier PDF enregistré — inclut la date ET l'heure
// pour distinguer plusieurs reçus générés le même jour.
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

export function SalesPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const { session, open, close } = useCashSession(currentStoreId);
  const printer = usePrinter();

  const [mode, setMode] = useState<"pos" | "form">("pos");
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [surfaceLocationId, setSurfaceLocationId] = useState<number | null>(null);
  const [loyaltyRatio, setLoyaltyRatio] = useState(0);
  const [businessSettings, setBusinessSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(
    null,
  );

  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState<string>("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [redeemPointsInput, setRedeemPointsInput] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [amountPaid, setAmountPaid] = useState<string>("");
  const [cashReceived, setCashReceived] = useState<string>("");
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [lastSaleNumber, setLastSaleNumber] = useState<string | null>(null);
  const [lastReceipt, setLastReceipt] = useState<ReceiptData | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const [showCloseSession, setShowCloseSession] = useState(false);
  const [expectedCash, setExpectedCash] = useState<number | null>(null);
  const [showPrinterPanel, setShowPrinterPanel] = useState(false);

  const refresh = useCallback(async () => {
    const [productsRows, variantsRows, customersRows, locations, settings] = await Promise.all([
      listProducts(db),
      listAllVariants(db),
      listCustomers(db),
      listLocations(db, currentStoreId ?? undefined),
      getSettings(db),
    ]);
    setProducts(productsRows);
    setVariants(variantsRows);
    setCustomers(customersRows);
    setLoyaltyRatio(settings.loyaltyPointsRatio);
    setBusinessSettings(settings);
    const surface = locations.find((l) => l.type === "surface_vente" || l.type.startsWith("surface_vente#"));
    setSurfaceLocationId(surface?.id ?? null);
  }, [db, currentStoreId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return products;
    return products.filter((p) => p.name.toLowerCase().includes(term));
  }, [products, search]);

  // TVA désactivée globalement -> toujours 0, quel que soit le taux
  // configuré sur le produit. Sinon, taux du produit ou, à défaut, taux par
  // défaut de l'entreprise.
  const resolveTaxRate = (product: Product) =>
    businessSettings?.taxEnabled ? (product.taxRate ?? businessSettings.defaultTaxRate ?? 0) : 0;

  const addVariantToCart = (variant: Variant, product: Product) => {
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

  const addToCart = (product: Product) => {
    const variant = variants.find((v) => v.productId === product.id);
    if (!variant) return;
    addVariantToCart(variant, product);
  };

  const handleBarcodeScan = useCallback(
    (code: string) => {
      const variant = variants.find((v) => v.barcode === code);
      if (!variant) {
        setCheckoutError(`Aucun produit avec le code-barres "${code}".`);
        return;
      }
      const product = products.find((p) => p.id === variant.productId);
      if (!product) return;
      setCheckoutError(null);
      addVariantToCart(variant, product);
    },
    [variants, products],
  );

  useBarcodeScanner({ onScan: handleBarcodeScan, enabled: !!session });

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

  const handlePaymentMethodChange = (method: PaymentMethod) => {
    setPaymentMethod(method);
    // Le crédit sous-entend "rien payé pour l'instant" — sans ça, le champ
    // montant payé reste vide = total, et la vente serait enregistrée comme
    // intégralement payée malgré le mode "Crédit" sélectionné.
    setAmountPaid(method === "credit" ? "0" : "");
    setCashReceived("");
  };

  // Prix TTC : le sous-total est déjà le montant payé par le client, la TVA
  // n'est qu'extraite pour l'affichage (voir SalesService.computeTaxAmount),
  // jamais ajoutée au total.
  const subtotal = cart.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const taxTotal = cart.reduce((sum, line) => {
    const gross = line.quantity * line.unitPrice;
    return sum + (line.taxRate > 0 ? gross * (line.taxRate / (100 + line.taxRate)) : 0);
  }, 0);
  const totalBeforeRedemption = subtotal;

  const selectedCustomer = customers.find((c) => c.id === Number(customerId));
  const maxRedeemablePoints =
    selectedCustomer && loyaltyRatio > 0
      ? Math.min(selectedCustomer.loyaltyPoints, totalBeforeRedemption * loyaltyRatio)
      : 0;
  const redeemPointsValue = Math.min(Number(redeemPointsInput) || 0, maxRedeemablePoints);
  const redemptionDiscount = pointsToDiscount(redeemPointsValue, loyaltyRatio);
  const total = Math.max(0, totalBeforeRedemption - redemptionDiscount);

  const paidValuePreview = amountPaid === "" ? total : Number(amountPaid);
  const needsCustomerIdentification = paymentMethod === "credit" || paidValuePreview < total;

  // Aide-mémoire purement local pour le caissier — jamais envoyé à createSale
  // ni stocké : "Montant payé" reste la seule valeur qui pilote le
  // crédit/partiel.
  const changeDue = Math.max(0, (Number(cashReceived) || 0) - total);

  const handleCheckout = async () => {
    setCheckoutError(null);
    if (!user || !surfaceLocationId || !currentStoreId) return;
    if (cart.length === 0) {
      setCheckoutError("Le panier est vide.");
      return;
    }

    setCheckingOut(true);
    try {
      const paidValue = amountPaid === "" ? total : Number(amountPaid);

      const sale = await createSale(db, {
        userId: user.id,
        customerId: customerId ? Number(customerId) : null,
        newCustomerName: customerId ? undefined : newCustomerName,
        saleMode: mode,
        items: cart.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          taxRate: line.taxRate,
        })),
        redeemPoints: redeemPointsValue || undefined,
        paymentMethod,
        amountPaid: paidValue,
        surfaceLocationId,
        storeId: currentStoreId,
      });

      const customerName =
        customers.find((c) => c.id === Number(customerId))?.fullName || newCustomerName.trim() || undefined;

      setLastSaleNumber(sale.number);
      setLastReceipt({
        businessName: businessSettings?.businessName ?? undefined,
        businessAddress: businessSettings?.address ?? undefined,
        businessPhone: businessSettings?.phone ?? undefined,
        businessEmail: businessSettings?.email ?? undefined,
        logoDataUrl: businessSettings?.logoDataUrl ?? undefined,
        columns: businessSettings?.receiptColumns,
        saleNumber: sale.number,
        date: new Date().toLocaleString("fr-FR"),
        cashierName: user.fullName,
        customerName,
        lines: cart.map((line) => ({
          label: line.productName,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          total: line.quantity * line.unitPrice,
        })),
        subtotal,
        discount: redemptionDiscount,
        tax: taxTotal,
        total,
        paymentMethod,
        amountPaid: paidValue,
      });
      setPrintError(null);
      setCart([]);
      setCustomerId("");
      setNewCustomerName("");
      setRedeemPointsInput("");
      setAmountPaid("");
      setPaymentMethod("cash");
      setCashReceived("");
      await refresh();
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : "Impossible d'enregistrer la vente.");
    } finally {
      setCheckingOut(false);
    }
  };

  if (session === undefined) {
    return <div style={{ padding: 24 }}>Chargement...</div>;
  }

  if (!session) {
    return <OpenCashSessionScreen onOpen={open} />;
  }

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Ventes</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setMode("pos")}
            style={{
              ...primaryButtonStyle,
              background: mode === "pos" ? "var(--gradient-accent)" : "transparent",
              color: mode === "pos" ? "#0f172a" : "var(--color-text)",
              border: mode === "pos" ? "none" : "1px solid var(--color-border)",
            }}
          >
            Mode Caisse
          </button>
          <button
            onClick={() => setMode("form")}
            style={{
              ...primaryButtonStyle,
              background: mode === "form" ? "var(--gradient-accent)" : "transparent",
              color: mode === "form" ? "#0f172a" : "var(--color-text)",
              border: mode === "form" ? "none" : "1px solid var(--color-border)",
            }}
          >
            Mode Formulaire
          </button>
          <button
            onClick={() => setShowPrinterPanel((v) => !v)}
            style={{ background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)", borderRadius: 8, padding: "0 16px" }}
          >
            Imprimante
          </button>
          <button
            onClick={async () => {
              if (showCloseSession) {
                setShowCloseSession(false);
                return;
              }
              setExpectedCash(await getExpectedCashAmount(db, session));
              setShowCloseSession(true);
            }}
            style={{ background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)", borderRadius: 8, padding: "0 16px" }}
          >
            Fermer la caisse
          </button>
        </div>
      </div>

      {showPrinterPanel && <PrinterPanel />}

      {showCloseSession && expectedCash !== null && (
        <CloseCashSessionPanel
          expectedAmount={expectedCash}
          onCancel={() => setShowCloseSession(false)}
          onClose={async (counted, expected) => {
            await close({ closingAmount: counted, expectedAmount: expected });
            setShowCloseSession(false);
          }}
        />
      )}

      {lastSaleNumber && (
        <div
          style={{
            ...cardStyle,
            borderLeft: "4px solid #86efac",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>
            Vente enregistrée : <strong>{lastSaleNumber}</strong>
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={primaryButtonStyle}
              disabled={!printer.connected || !lastReceipt}
              title={!printer.connected ? "Connecte une imprimante pour imprimer le ticket" : undefined}
              onClick={async () => {
                if (!lastReceipt) return;
                setPrintError(null);
                try {
                  await printer.print(await buildReceipt(lastReceipt));
                } catch (err) {
                  setPrintError(err instanceof Error ? err.message : "Impression impossible.");
                }
              }}
            >
              Imprimer le ticket
            </button>
            <button
              style={{
                ...primaryButtonStyle,
                background: "transparent",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
              disabled={!lastReceipt}
              onClick={() => {
                if (!lastReceipt) return;
                const blob = buildReceiptPdf(lastReceipt);
                downloadBlob(blob, `recu-${lastSaleNumber}-${timestampForFilename()}.pdf`);
              }}
            >
              Enregistrer en PDF
            </button>
          </div>
        </div>
      )}

      {printError && <p style={{ color: "#f87171" }}>{printError}</p>}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 24, marginTop: 24 }}>
        <div>
          {mode === "pos" ? (
            <>
              <input
                style={inputStyle}
                placeholder="Rechercher un produit..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <p style={{ color: "var(--color-text-muted)", fontSize: 13, marginTop: 4 }}>
                Scanne un code-barres à tout moment pour ajouter directement au panier.
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                  gap: 12,
                  marginTop: 16,
                }}
              >
                {filteredProducts.map((product) => (
                  <button
                    key={product.id}
                    onClick={() => addToCart(product)}
                    style={{
                      padding: 16,
                      borderRadius: 12,
                      border: "1px solid var(--color-border)",
                      background: "var(--color-bg-elevated)",
                      color: "var(--color-text)",
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{product.name}</div>
                    <div style={{ color: "var(--color-text-muted)" }}>{product.salePrice} XOF</div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div style={cardStyle}>
              <label>
                Ajouter un article
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
              </label>
            </div>
          )}
        </div>

        <div style={cardStyle}>
          <strong>Panier</strong>
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

          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
            <div>Sous-total : {subtotal.toFixed(0)}</div>
            <div>Taxe : {taxTotal.toFixed(0)}</div>
            {redemptionDiscount > 0 && (
              <div style={{ color: "#86efac" }}>Réduction fidélité : -{redemptionDiscount.toFixed(0)}</div>
            )}
            <div style={{ fontWeight: 700, fontSize: 18 }}>Total : {total.toFixed(0)}</div>
          </div>

          <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
            Facultatif pour un client de passage. Renseigne un nom uniquement pour le crédit, un
            paiement partiel, ou si tu veux suivre un client fidèle.
          </p>

          <label>
            Client déjà enregistré
            <SearchableSelect
              value={customerId}
              onChange={(id) => {
                setCustomerId(id);
                setRedeemPointsInput("");
              }}
              options={customers.map((c) => ({ value: String(c.id), label: c.fullName }))}
              emptyLabel="— Client de passage —"
              placeholder="Rechercher un client..."
            />
          </label>

          {selectedCustomer && maxRedeemablePoints > 0 && (
            <label>
              Points fidélité ({selectedCustomer.loyaltyPoints} pts disponibles) — utiliser jusqu'à{" "}
              {maxRedeemablePoints.toFixed(0)} pts
              <input
                style={inputStyle}
                type="number"
                min={0}
                max={maxRedeemablePoints}
                value={redeemPointsInput}
                onChange={(e) => setRedeemPointsInput(e.target.value)}
                placeholder="0"
              />
              {redeemPointsValue > 0 && (
                <span style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
                  Réduction : {redemptionDiscount.toFixed(0)}
                </span>
              )}
            </label>
          )}
          {!customerId && (
            <label>
              Ou nom du client{needsCustomerIdentification ? " (requis pour le crédit)" : " (optionnel)"}
              <input
                style={{
                  ...inputStyle,
                  border: needsCustomerIdentification && !newCustomerName.trim() ? "1px solid #f87171" : inputStyle.border,
                }}
                value={newCustomerName}
                onChange={(e) => setNewCustomerName(e.target.value)}
                placeholder="Nom du client"
              />
            </label>
          )}

          <label>
            Méthode de paiement
            <select
              style={inputStyle}
              value={paymentMethod}
              onChange={(e) => handlePaymentMethodChange(e.target.value as PaymentMethod)}
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
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value)}
              placeholder={total.toFixed(0)}
            />
          </label>

          {paymentMethod === "cash" && (
            <label>
              Montant reçu (espèces)
              <input
                style={inputStyle}
                type="number"
                value={cashReceived}
                onChange={(e) => setCashReceived(e.target.value)}
                placeholder={total.toFixed(0)}
              />
              {cashReceived !== "" && (
                <div style={{ fontWeight: 700, fontSize: 16, marginTop: 4 }}>
                  Monnaie à rendre : {changeDue.toFixed(0)}
                </div>
              )}
            </label>
          )}

          {checkoutError && <p style={{ color: "#f87171" }}>{checkoutError}</p>}

          <button style={primaryButtonStyle} onClick={handleCheckout} disabled={checkingOut}>
            {checkingOut ? "Encaissement..." : "Encaisser"}
          </button>
        </div>
      </div>
    </main>
  );
}
