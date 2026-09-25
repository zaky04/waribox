import { formatAmount } from "../../lib/format";
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
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { SearchableSelect } from "../../components/SearchableSelect";
import {
  amountStyle,
  cardStyle,
  inputStyle,
  pageStyle,
  primaryButtonStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "../../components/sharedStyles";
import { IconCamera } from "../../components/icons";
import { Stamp } from "../../components/Stamp";
import { TicketEdge } from "../../components/TicketEdge";
import { openExternalUrl } from "../../lib/openExternalUrl";
import { saveGeneratedFile } from "../../lib/saveFile";
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

// Utilisé pour le nom du fichier PDF enregistré — inclut la date ET l'heure
// pour distinguer plusieurs reçus générés le même jour.
function timestampForFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

// Deux lettres pour la tuile produit (majuscule + minuscule : "Riz" -> "Ri").
function productMonogram(name: string): string {
  const letters = name.trim().replace(/[^\p{L}\p{N}]/gu, "");
  if (!letters) return "?";
  return letters[0]!.toUpperCase() + (letters[1]?.toLowerCase() ?? "");
}

export function SalesPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const { t } = useTranslation();
  const { session, open, close } = useCashSession(currentStoreId);
  const printer = usePrinter();

  const paymentMethods: { value: PaymentMethod; label: string }[] = [
    { value: "cash", label: t("sales.paymentMethods.cash") },
    { value: "card", label: t("sales.paymentMethods.card") },
    { value: "mobile_money", label: t("sales.paymentMethods.mobile_money") },
    { value: "credit", label: t("sales.paymentMethods.credit") },
  ];

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
        setCheckoutError(t("sales.noProductForBarcode", { code }));
        return;
      }
      const product = products.find((p) => p.id === variant.productId);
      if (!product) return;
      setCheckoutError(null);
      addVariantToCart(variant, product);
    },
    [variants, products, t],
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
      setCheckoutError(t("sales.emptyCartError"));
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
        // "pending" plutôt qu'une relecture de `sale.fneStatus` (qui reste
        // encore `null` à cet instant — la ligne n'est marquée "pending" par
        // `enqueueFneCertification` qu'APRÈS le retour de `createSale`, voir
        // CLAUDE.md) : on sait déjà ici, de façon fiable, si la FNE va
        // s'appliquer à cette vente.
        fneStatus: businessSettings?.fneEnabled ? "pending" : undefined,
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
      setCheckoutError(err instanceof Error ? err.message : t("sales.saleError"));
    } finally {
      setCheckingOut(false);
    }
  };

  if (session === undefined) {
    return <div style={{ padding: 24 }}>{t("sales.loading")}</div>;
  }

  if (!session) {
    return <OpenCashSessionScreen onOpen={open} />;
  }

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1>{t("sales.title")}</h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <div role="group" style={{ display: "flex", border: "1px solid var(--color-text)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
            {(["pos", "form"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                style={{
                  height: 38,
                  padding: "0 16px",
                  border: "none",
                  background: mode === m ? "var(--color-text)" : "transparent",
                  color: mode === m ? "var(--color-bg)" : "var(--color-text)",
                  fontSize: 14,
                  fontWeight: mode === m ? 600 : 500,
                  cursor: "pointer",
                }}
              >
                {m === "pos" ? t("sales.modePos") : t("sales.modeForm")}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowPrinterPanel((v) => !v)}
            style={{ background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)", borderRadius: "var(--radius-md)", padding: "0 16px" }}
          >
            {t("sales.printer")}
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
            style={{ background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)", borderRadius: "var(--radius-md)", padding: "0 16px" }}
          >
            {t("sales.closeCashSession")}
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
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <Stamp key={lastSaleNumber} text={t("sales.stampPaid")} subText={lastSaleNumber} width={190} />
            <span>
              {t("sales.saleRegistered")} <strong style={amountStyle}>{lastSaleNumber}</strong>
            </span>
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              style={primaryButtonStyle}
              disabled={!printer.connected || !lastReceipt}
              title={!printer.connected ? t("sales.printerRequiredTooltip") : undefined}
              onClick={async () => {
                if (!lastReceipt) return;
                setPrintError(null);
                try {
                  await printer.print(await buildReceipt(lastReceipt));
                } catch (err) {
                  setPrintError(err instanceof Error ? err.message : t("sales.printError"));
                }
              }}
            >
              {t("sales.printTicket")}
            </button>
            <button
              style={{
                ...primaryButtonStyle,
                background: "transparent",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
              disabled={!lastReceipt}
              onClick={async () => {
                if (!lastReceipt) return;
                const blob = buildReceiptPdf(lastReceipt);
                await saveGeneratedFile(blob, `recu-${lastSaleNumber}-${timestampForFilename()}.pdf`);
              }}
            >
              {t("sales.saveAsPdf")}
            </button>
            <input
              style={{ ...inputStyle, width: 140, marginTop: 0 }}
              placeholder={t("sales.customerPhonePlaceholder")}
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
              {t("sales.sendWhatsapp")}
            </button>
          </div>
        </div>
      )}

      {printError && <p style={{ color: "var(--color-danger)" }}>{printError}</p>}

      <div className="cart-layout-grid">
        <div>
          {mode === "pos" ? (
            <>
              <input
                style={inputStyle}
                placeholder={t("sales.searchProductPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("sales.scanHint")}</p>
                {isCameraScanSupported() && (
                  <button
                    onClick={() => setShowCameraScanner(true)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
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
                    <IconCamera size={14} />
                    {t("sales.scanCamera")}
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
                  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                  gap: 12,
                  marginTop: 16,
                }}
              >
                {filteredProducts.map((product) => {
                  const inCart = cart.filter((line) => line.productId === product.id).reduce((sum, line) => sum + line.quantity, 0);
                  return (
                    <button
                      key={product.id}
                      onClick={() => addToCart(product)}
                      style={{
                        position: "relative",
                        display: "flex",
                        flexDirection: "column",
                        padding: 0,
                        textAlign: "left",
                        border: "1px solid var(--color-border)",
                        borderRadius: "var(--radius-md)",
                        background: "var(--color-bg-elevated)",
                        color: "var(--color-text)",
                        overflow: "hidden",
                        cursor: "pointer",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          height: 76,
                          background: `var(--tint-${(product.id % 5) + 1})`,
                          fontSize: 32,
                          fontWeight: 700,
                          letterSpacing: "-0.02em",
                        }}
                      >
                        {productMonogram(product.name)}
                      </span>
                      <span style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 12px 12px" }}>
                        <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.25, minHeight: 35 }}>{product.name}</span>
                        <span style={{ ...amountStyle, fontSize: 15, fontWeight: 600 }}>{formatAmount(product.salePrice)}&nbsp;F</span>
                      </span>
                      {inCart > 0 && (
                        <span
                          style={{
                            ...amountStyle,
                            position: "absolute",
                            top: 8,
                            right: 8,
                            minWidth: 24,
                            height: 24,
                            boxSizing: "border-box",
                            padding: "0 7px",
                            borderRadius: 4,
                            background: "var(--color-text)",
                            color: "var(--color-bg)",
                            fontSize: 13,
                            fontWeight: 600,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          ×{inCart}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div style={cardStyle}>
              <label>
                {t("sales.addItem")}
                <SearchableSelect
                  value=""
                  onChange={(id) => {
                    const product = products.find((p) => p.id === Number(id));
                    if (product) addToCart(product);
                  }}
                  options={products.map((p) => ({ value: String(p.id), label: p.name }))}
                  emptyLabel={t("sales.chooseProduct")}
                  placeholder={t("sales.searchProductPlaceholder")}
                />
              </label>
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <TicketEdge position="top" />
            <div
              style={{
                background: "var(--color-ticket)",
                borderLeft: "1px solid var(--color-border)",
                borderRight: "1px solid var(--color-border)",
                padding: "14px 20px 18px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                fontSize: 14,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{t("sales.cart")}</h2>
              <div style={{ borderBottom: "1px dashed var(--color-rule-strong)", margin: "6px 0 4px" }} />

              {activePromotions.length > 0 && (
                <div
                  style={{
                    border: "1px dashed var(--color-rule-strong)",
                    borderRadius: "var(--radius-md)",
                    padding: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <strong style={{ fontSize: 13 }}>{t("sales.activePromotions")}</strong>
                  {activePromotions.map((promo) => (
                    <label key={promo.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={checkedPromotionIds.has(promo.id)}
                        onChange={() => togglePromotion(promo.id)}
                      />
                      {promo.name} — -{promo.discountPercent}% (
                      {promo.scope === "product" ? t("sales.promoScopeProduct") : t("sales.promoScopeInvoice")})
                    </label>
                  ))}
                </div>
              )}

              {cart.length === 0 ? (
                <p
                  style={{
                    margin: "10px 0",
                    textAlign: "center",
                    fontFamily: "var(--font-hand)",
                    fontSize: 22,
                    fontWeight: 600,
                    color: "var(--color-text-muted)",
                  }}
                >
                  {t("sales.emptyCart")}
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", maxHeight: 300, overflowY: "auto" }}>
                  {cart.map((line) => {
                    const lineGross = line.quantity * line.unitPrice;
                    const promo = lineDiscount(line.productId);
                    const lineDiscountAmount = lineGross * (promo.percent / 100);
                    const stepper = {
                      width: 26,
                      height: 26,
                      padding: 0,
                      border: "1px solid var(--color-rule-strong)",
                      borderRadius: 4,
                      background: "transparent",
                      color: "var(--color-text)",
                      fontSize: 15,
                      lineHeight: 1,
                      cursor: "pointer",
                    } as const;
                    return (
                      <div key={line.variantId} style={{ padding: "5px 0" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <button
                            type="button"
                            aria-label={t("sales.removeOne")}
                            style={stepper}
                            onClick={() =>
                              line.quantity > 1
                                ? updateQuantity(line.variantId, line.quantity - 1)
                                : removeLine(line.variantId)
                            }
                          >
                            −
                          </button>
                          <span style={{ ...amountStyle, minWidth: 22, textAlign: "center", fontSize: 13, fontWeight: 600 }}>
                            {line.quantity}
                          </span>
                          <button
                            type="button"
                            aria-label={t("sales.addOne")}
                            style={stepper}
                            onClick={() => updateQuantity(line.variantId, line.quantity + 1)}
                          >
                            +
                          </button>
                          <span style={{ fontSize: 14, fontWeight: 500, marginLeft: 4, minWidth: 0, overflowWrap: "anywhere" }}>
                            {line.productName}
                          </span>
                          <span
                            style={{ flexGrow: 1, minWidth: 8, borderBottom: "2px dotted var(--color-dot)", transform: "translateY(-3px)" }}
                          />
                          <span style={{ ...amountStyle, fontSize: 14, fontWeight: 500 }}>
                            {formatAmount(lineGross - lineDiscountAmount)}
                          </span>
                        </div>
                        {promo.percent > 0 && (
                          <div style={{ color: "var(--color-success)", fontSize: 12, marginLeft: 92 }}>
                            {t("sales.promo")}
                            {promo.name ? ` ${promo.name}` : ""} -{promo.percent}%
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{ borderBottom: "1px dashed var(--color-rule-strong)", margin: "8px 0 4px" }} />
              {[
                { label: t("sales.subtotal"), value: formatAmount(subtotal), show: true, color: undefined },
                { label: t("sales.tax"), value: formatAmount(taxTotal), show: true, color: undefined },
                {
                  label: t("sales.productPromoDiscount"),
                  value: "-" + formatAmount(productPromoDiscount),
                  show: productPromoDiscount > 0,
                  color: "var(--color-success)",
                },
                {
                  label: t("sales.invoicePromoDiscount") + (checkedInvoicePromo ? " " + checkedInvoicePromo.name : ""),
                  value: "-" + formatAmount(invoicePromoDiscount),
                  show: invoicePromoDiscount > 0,
                  color: "var(--color-success)",
                },
                {
                  label: t("sales.loyaltyDiscount"),
                  value: "-" + formatAmount(redemptionDiscount),
                  show: redemptionDiscount > 0,
                  color: "var(--color-success)",
                },
              ]
                .filter((row) => row.show)
                .map((row) => (
                  <div
                    key={row.label}
                    style={{ display: "flex", alignItems: "baseline", gap: 8, color: row.color ?? "var(--color-text-muted)" }}
                  >
                    <span>{row.label}</span>
                    <span style={{ flexGrow: 1, borderBottom: "2px dotted var(--color-dot)" }} />
                    <span style={amountStyle}>{row.value}</span>
                  </div>
                ))}
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 6 }}>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{t("sales.totalLabel")}</span>
                <span style={{ ...amountStyle, fontSize: 34, fontWeight: 600, letterSpacing: "-0.02em" }}>
                  {formatAmount(total)}&nbsp;F
                </span>
              </div>
            </div>
            <TicketEdge position="bottom" />
          </div>

          <div style={{ ...cardStyle, marginTop: 0 }}>
            <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("sales.customerOptionalHint")}</p>

            <label>
              {t("sales.registeredCustomer")}
              <SearchableSelect
                value={customerId}
                onChange={(id) => {
                  setCustomerId(id);
                  setRedeemPointsInput("");
                }}
                options={customers.map((c) => ({ value: String(c.id), label: c.fullName }))}
                emptyLabel={t("sales.noCustomer")}
                placeholder={t("sales.searchCustomerPlaceholder")}
              />
            </label>

            {selectedCustomer && maxRedeemablePoints > 0 && (
              <label>
                {t("sales.loyaltyPoints")} ({selectedCustomer.loyaltyPoints} {t("sales.loyaltyPointsAvailable")}{" "}
                {formatAmount(maxRedeemablePoints)} {t("sales.pts")}
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
                    {t("sales.pointsReductionLabel")} {formatAmount(redemptionDiscount)}
                  </span>
                )}
              </label>
            )}
            {!customerId && (
              <label>
                {t("sales.orCustomerName")}
                {needsCustomerIdentification ? t("sales.requiredForCredit") : t("sales.optional")}
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
                  placeholder={t("sales.customerNamePlaceholder")}
                />
              </label>
            )}

            <div role="group" aria-label={t("sales.paymentMethod")}>
              <div style={{ fontSize: 14, marginBottom: 6 }}>{t("sales.paymentMethod")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
                {paymentMethods.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    aria-pressed={paymentMethod === m.value}
                    onClick={() => handlePaymentMethodChange(m.value)}
                    style={{
                      height: 40,
                      border: "1px solid var(--color-text)",
                      borderRadius: "var(--radius-md)",
                      background: paymentMethod === m.value ? "var(--color-text)" : "transparent",
                      color: paymentMethod === m.value ? "var(--color-bg)" : "var(--color-text)",
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <label>
              {t("sales.amountPaid")}
              <input
                style={{ ...inputStyle, ...amountStyle }}
                type="number"
                value={amountPaid}
                onChange={(e) => setAmountPaid(e.target.value)}
                placeholder={total.toFixed(0)}
              />
            </label>

            {paymentMethod === "cash" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <label>
                  {t("sales.cashReceived")}
                  <input
                    style={{ ...inputStyle, ...amountStyle, textAlign: "right", fontSize: 20, fontWeight: 600 }}
                    type="number"
                    value={cashReceived}
                    onChange={(e) => setCashReceived(e.target.value)}
                    placeholder={total.toFixed(0)}
                  />
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {[null, 500, 1000, 2000, 5000, 10000, 20000, 50000].map((bill) => {
                    const value = bill === null ? total : bill;
                    const selected = total > 0 && Number(cashReceived) === value;
                    return (
                      <button
                        key={bill ?? "exact"}
                        type="button"
                        onClick={() => setCashReceived(String(Math.round(value)))}
                        style={{
                          ...amountStyle,
                          height: 34,
                          padding: "0 12px",
                          border: "1px solid var(--color-rule-strong)",
                          borderRadius: "var(--radius-md)",
                          background: selected ? "var(--color-text)" : "var(--color-bg-elevated)",
                          color: selected ? "var(--color-bg)" : "var(--color-text)",
                          fontSize: 13,
                          fontWeight: 500,
                          cursor: "pointer",
                        }}
                      >
                        {bill === null ? t("sales.exactAmount") : String(bill).replace(/\B(?=(\d{3})+(?!\d))/g, " ")}
                      </button>
                    );
                  })}
                </div>
                {cashReceived !== "" && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      border: "2px solid var(--color-accent)",
                      borderRadius: "var(--radius-md)",
                      padding: "10px 14px",
                      color: "var(--color-accent)",
                    }}
                  >
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{t("sales.changeDue")}</span>
                    <span style={{ ...amountStyle, fontSize: 26, fontWeight: 600 }}>{formatAmount(changeDue)}&nbsp;F</span>
                  </div>
                )}
              </div>
            )}

            {checkoutError && <p style={{ color: "var(--color-danger)" }}>{checkoutError}</p>}

            <button style={{ ...primaryButtonStyle, height: 56, fontSize: 18 }} onClick={handleCheckout} disabled={checkingOut}>
              {checkingOut ? t("sales.checkingOut") : t("sales.checkout")}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
