import {
  createSale,
  getActivePromotionsWithProducts,
  getExpectedCashAmount,
  getSettings,
  listCustomers,
  listLocations,
  listProducts,
  listAllVariants,
  pointsToDiscount,
  type ActivePromotionWithProducts,
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
import { openExternalUrl } from "../../lib/openExternalUrl";
import { buildReceiptWhatsAppMessage, buildWhatsAppLink } from "../../lib/whatsapp";
import { useAuth } from "../auth/useAuth";
import { PrinterPanel } from "../printer/PrinterPanel";
import { usePrinter } from "../printer/usePrinter";
import { BarcodeCameraScanner, isCameraScanSupported } from "./BarcodeCameraScanner";
import { CloseCashSessionPanel } from "./CloseCashSessionPanel";
import { OpenCashSessionScreen } from "./OpenCashSessionScreen";
import { useBarcodeScanner } from "./useBarcodeScanner";
import { useCashSession } from "./useCashSession";

type Product = typeof schema.products.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;
type Customer = typeof schema.customers.$inferSelect;

interface CartLine {
  variantId: number;
  productId: number;
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
  const [activePromotions, setActivePromotions] = useState<ActivePromotionWithProducts[]>([]);
  // Cases à cocher : une promotion "en cours" ne s'applique que si elle est
  // cochée — cochées par défaut à chaque rafraîchissement (une promo active
  // s'applique "par défaut", le caissier peut décocher au cas par cas), mais
  // jamais appliquée silencieusement sans passer par cette case.
  const [checkedPromotionIds, setCheckedPromotionIds] = useState<Set<number>>(new Set());

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
  const [receiptPhone, setReceiptPhone] = useState("");
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
    if (settings.enablePromotions) {
      const promos = await getActivePromotionsWithProducts(db);
      setActivePromotions(promos);
      setCheckedPromotionIds(new Set(promos.map((p) => p.id)));
    } else {
      setActivePromotions([]);
      setCheckedPromotionIds(new Set());
    }
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
          productId: product.id,
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

  const [showCameraScanner, setShowCameraScanner] = useState(false);

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

  const togglePromotion = (promotionId: number) => {
    setCheckedPromotionIds((prev) => {
      const next = new Set(prev);
      if (next.has(promotionId)) next.delete(promotionId);
      else next.add(promotionId);
      return next;
    });
  };

  // Seules les promotions cochées comptent — une promotion "en cours" mais
  // décochée par le caissier ne s'applique pas, quel que soit son statut en
  // base (voir la case à cocher affichée à côté du panier).
  const checkedProductPromos = activePromotions.filter(
    (p) => p.scope === "product" && checkedPromotionIds.has(p.id),
  );
  const checkedInvoicePromos = activePromotions.filter(
    (p) => p.scope === "invoice" && checkedPromotionIds.has(p.id),
  );
  // Si plusieurs promotions cochées visent le même produit, on retient la
  // plus avantageuse plutôt que de les cumuler (même convention que
  // PromotionsService.getActiveProductDiscounts).
  function lineDiscount(productId: number): { percent: number; name?: string } {
    let best = { percent: 0, name: undefined as string | undefined };
    for (const promo of checkedProductPromos) {
      if (promo.productIds.includes(productId) && promo.discountPercent > best.percent) {
        best = { percent: promo.discountPercent, name: promo.name };
      }
    }
    return best;
  }
  const checkedInvoicePromo =
    checkedInvoicePromos.length > 0
      ? checkedInvoicePromos.reduce((best, p) => (p.discountPercent > best.discountPercent ? p : best))
      : null;

  // Prix TTC : le sous-total est déjà le montant payé par le client, la TVA
  // n'est qu'extraite pour l'affichage (voir SalesService.computeTaxAmount),
  // jamais ajoutée au total.
  const subtotal = cart.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const taxTotal = cart.reduce((sum, line) => {
    const gross = line.quantity * line.unitPrice;
    return sum + (line.taxRate > 0 ? gross * (line.taxRate / (100 + line.taxRate)) : 0);
  }, 0);
  // Remise promo "produit" : appliquée ligne par ligne, en pourcentage
  // (jamais un montant fixe stocké dans le panier) pour rester correcte si la
  // quantité change après l'ajout au panier.
  const productPromoDiscount = cart.reduce(
    (sum, line) => sum + line.quantity * line.unitPrice * (lineDiscount(line.productId).percent / 100),
    0,
  );
  const itemsTotal = subtotal - productPromoDiscount;
  // Remise promo "facture" : un pourcentage du total après remises produit,
  // jamais cumulée avec elles sur la même base (éviterait une remise > 100%
  // en cas de superposition de promotions).
  const invoicePromoDiscount = checkedInvoicePromo ? itemsTotal * (checkedInvoicePromo.discountPercent / 100) : 0;
  const totalBeforeRedemption = itemsTotal - invoicePromoDiscount;

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
        items: cart.map((line) => {
          const percent = lineDiscount(line.productId).percent;
          return {
            variantId: line.variantId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            taxRate: line.taxRate,
            discount: percent > 0 ? line.quantity * line.unitPrice * (percent / 100) : undefined,
          };
        }),
        discount: invoicePromoDiscount > 0 ? invoicePromoDiscount : undefined,
        redeemPoints: redeemPointsValue || undefined,
        paymentMethod,
        amountPaid: paidValue,
        surfaceLocationId,
        storeId: currentStoreId,
      }, user.permissions);

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
        discount: productPromoDiscount + invoicePromoDiscount + redemptionDiscount,
        tax: taxTotal,
        total,
        paymentMethod,
        amountPaid: paidValue,
      });
      setReceiptPhone(customers.find((c) => c.id === Number(customerId))?.phone ?? "");
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
            <input
              style={{ ...inputStyle, width: 140, marginTop: 0 }}
              placeholder="Téléphone client"
              value={receiptPhone}
              onChange={(e) => setReceiptPhone(e.target.value)}
            />
            <button
              style={{
                ...primaryButtonStyle,
                background: "transparent",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
              disabled={!lastReceipt || !receiptPhone.trim()}
              onClick={() => {
                if (!lastReceipt) return;
                const message = buildReceiptWhatsAppMessage(lastReceipt);
                void openExternalUrl(buildWhatsAppLink(receiptPhone, businessSettings?.whatsappCountryCode, message));
              }}
            >
              Envoyer par WhatsApp
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
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
                  Scanne un code-barres à tout moment pour ajouter directement au panier.
                </p>
                {isCameraScanSupported() && (
                  <button
                    onClick={() => setShowCameraScanner(true)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--color-border)",
                      background: "transparent",
                      color: "var(--color-text)",
                      fontSize: 13,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    📷 Scanner (caméra)
                  </button>
                )}
              </div>
              {showCameraScanner && (
                <BarcodeCameraScanner
                  onDetected={(code) => {
                    setShowCameraScanner(false);
                    handleBarcodeScan(code);
                  }}
                  onClose={() => setShowCameraScanner(false)}
                />
              )}
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

          {activePromotions.length > 0 && (
            <div
              style={{
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                padding: 10,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <strong style={{ fontSize: 13 }}>Promotions en cours</strong>
              {activePromotions.map((promo) => (
                <label key={promo.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={checkedPromotionIds.has(promo.id)}
                    onChange={() => togglePromotion(promo.id)}
                  />
                  {promo.name} — -{promo.discountPercent}% ({promo.scope === "product" ? "produits" : "facture"})
                </label>
              ))}
            </div>
          )}

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
                {cart.map((line) => {
                  const lineGross = line.quantity * line.unitPrice;
                  const promo = lineDiscount(line.productId);
                  const lineDiscountAmount = lineGross * (promo.percent / 100);
                  return (
                    <tr key={line.variantId}>
                      <td style={tdStyle}>
                        {line.productName}
                        {promo.percent > 0 && (
                          <div style={{ color: "#86efac", fontSize: 12 }}>
                            Promo{promo.name ? ` ${promo.name}` : ""} -{promo.percent}%
                          </div>
                        )}
                      </td>
                      <td style={tdStyle}>
                        <input
                          type="number"
                          value={line.quantity}
                          onChange={(e) => updateQuantity(line.variantId, Number(e.target.value))}
                          style={{ ...inputStyle, width: 60, marginTop: 0 }}
                        />
                      </td>
                      <td style={tdStyle}>{(lineGross - lineDiscountAmount).toFixed(0)}</td>
                      <td style={tdStyle}>
                        <button
                          onClick={() => removeLine(line.variantId)}
                          style={{ background: "transparent", border: "none", color: "#f87171", cursor: "pointer" }}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
            <div>Sous-total : {subtotal.toFixed(0)}</div>
            <div>Taxe : {taxTotal.toFixed(0)}</div>
            {productPromoDiscount > 0 && (
              <div style={{ color: "#86efac" }}>Remise promo produits : -{productPromoDiscount.toFixed(0)}</div>
            )}
            {invoicePromoDiscount > 0 && (
              <div style={{ color: "#86efac" }}>
                Remise promo{checkedInvoicePromo ? ` ${checkedInvoicePromo.name}` : ""} : -
                {invoicePromoDiscount.toFixed(0)}
              </div>
            )}
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
