import {
  createPurchase,
  ensureVariantBarcode,
  getLowStockProducts,
  getSalesVelocity,
  listAllVariants,
  listProducts,
  listPurchases,
  listSuppliers,
  type LowStockEntry,
  type PurchasePaymentMethod,
} from "@gestion-boutique/core";
import { buildLabelSheetPdf } from "@gestion-boutique/printer";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { saveGeneratedFile } from "../../lib/saveFile";
import { useAuth } from "../auth/useAuth";

function timestampForFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

type Product = typeof schema.products.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;
type Supplier = typeof schema.suppliers.$inferSelect;
type Purchase = typeof schema.purchases.$inferSelect;

interface CartLine {
  variantId: number;
  productName: string;
  quantity: number;
  unitCost: number;
}

// Fenêtre à la fois utilisée pour lire la vitesse de vente passée (30
// derniers jours) et pour dimensionner la quantité suggérée (couvrir les 30
// prochains jours au même rythme) — une seule constante pour garder les deux
// symétriques et faciles à expliquer.
const REORDER_WINDOW_DAYS = 30;

export function PurchasesPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const { t } = useTranslation();

  const PAYMENT_METHODS: { value: PurchasePaymentMethod; label: string }[] = [
    { value: "cash", label: t("purchases.paymentMethods.cash") },
    { value: "card", label: t("purchases.paymentMethods.card") },
    { value: "mobile_money", label: t("purchases.paymentMethods.mobile_money") },
    { value: "credit", label: t("purchases.paymentMethods.credit") },
  ];

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [lowStockEntries, setLowStockEntries] = useState<LowStockEntry[]>([]);
  const [salesVelocity, setSalesVelocity] = useState<Map<number, number>>(new Map());

  const [supplierId, setSupplierId] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PurchasePaymentMethod>("cash");
  const [amountPaid, setAmountPaid] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastPurchaseLines, setLastPurchaseLines] = useState<CartLine[]>([]);
  const [printingLabels, setPrintingLabels] = useState(false);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastPurchaseNumber, setLastPurchaseNumber] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [supplierRows, productRows, variantRows, purchaseRows, lowStockRows, velocityMap] = await Promise.all([
      listSuppliers(db),
      listProducts(db),
      listAllVariants(db),
      listPurchases(db, currentStoreId ?? undefined),
      getLowStockProducts(db, currentStoreId ?? undefined),
      getSalesVelocity(db, REORDER_WINDOW_DAYS, currentStoreId ?? undefined),
    ]);
    setSuppliers(supplierRows);
    setProducts(productRows);
    setVariants(variantRows);
    setPurchases(purchaseRows);
    setLowStockEntries(lowStockRows);
    setSalesVelocity(velocityMap);
  }, [db, currentStoreId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addToCart = (product: Product, quantity = 1) => {
    const variant = variants.find((v) => v.productId === product.id);
    if (!variant) return;
    setCart((prev) => {
      const existing = prev.find((line) => line.variantId === variant.id);
      if (existing) {
        return prev.map((line) =>
          line.variantId === variant.id ? { ...line, quantity: line.quantity + quantity } : line,
        );
      }
      return [
        ...prev,
        {
          variantId: variant.id,
          productName: product.name,
          quantity,
          unitCost: product.purchasePrice,
        },
      ];
    });
  };

  // Vitesse de vente quotidienne réelle du produit (somme sur toutes ses
  // variantes) — 0 si aucune vente enregistrée sur la fenêtre.
  const productDailyVelocity = (productId: number): number =>
    variants
      .filter((v) => v.productId === productId)
      .reduce((sum, v) => sum + (salesVelocity.get(v.id) ?? 0), 0);

  // Quantité suggérée : couvre les `REORDER_WINDOW_DAYS` prochains jours au
  // rythme de vente réel des `REORDER_WINDOW_DAYS` derniers jours, moins le
  // stock déjà disponible — bascule sur l'ancien repère (ramener au double
  // du seuil d'alerte) quand le produit n'a aucune vente sur la période
  // (vitesse nulle, ex. produit tout juste ajouté au catalogue), pour rester
  // utile même sans historique. Dans les deux cas, un simple repère que le
  // commerçant reste libre d'ajuster avant de valider l'achat.
  const suggestedReorderQuantity = (entry: LowStockEntry): number => {
    const dailyVelocity = productDailyVelocity(entry.product.id);
    if (dailyVelocity > 0) {
      return Math.max(1, Math.ceil(dailyVelocity * REORDER_WINDOW_DAYS - entry.totalStock));
    }
    return Math.max(1, Math.ceil(entry.product.lowStockThreshold * 2 - entry.totalStock));
  };

  const isPredictedSuggestion = (entry: LowStockEntry): boolean => productDailyVelocity(entry.product.id) > 0;

  const updateQuantity = (variantId: number, quantity: number) => {
    setCart((prev) =>
      quantity <= 0
        ? prev.filter((line) => line.variantId !== variantId)
        : prev.map((line) => (line.variantId === variantId ? { ...line, quantity } : line)),
    );
  };

  const updateUnitCost = (variantId: number, unitCost: number) => {
    setCart((prev) =>
      prev.map((line) => (line.variantId === variantId ? { ...line, unitCost } : line)),
    );
  };

  const removeLine = (variantId: number) => {
    setCart((prev) => prev.filter((line) => line.variantId !== variantId));
  };

  const handlePaymentMethodChange = (method: PurchasePaymentMethod) => {
    setPaymentMethod(method);
    // Le crédit sous-entend "rien payé pour l'instant" — sans ça, le champ
    // montant payé reste vide = total, et l'achat serait enregistré comme
    // intégralement payé malgré le mode "Crédit" sélectionné (aucune dette
    // fournisseur ne serait alors créée).
    setAmountPaid(method === "credit" ? "0" : "");
  };

  const total = cart.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
  const paidValuePreview = amountPaid === "" ? total : Number(amountPaid);
  const willCreateDebt = paidValuePreview < total;

  const supplierName = (id: number) => suppliers.find((s) => s.id === id)?.name ?? "—";

  const handleSubmit = async () => {
    setError(null);
    if (!user || !currentStoreId) return;
    if (!supplierId) {
      setError(t("purchases.errors.supplierRequired"));
      return;
    }
    if (cart.length === 0) {
      setError(t("purchases.errors.itemRequired"));
      return;
    }

    setSaving(true);
    try {
      const paidValue = amountPaid === "" ? total : Number(amountPaid);
      const purchase = await createPurchase(db, {
        userId: user.id,
        supplierId: Number(supplierId),
        items: cart.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          unitCost: line.unitCost,
        })),
        paymentMethod,
        amountPaid: paidValue,
        dueDate: dueDate || undefined,
        storeId: currentStoreId,
      }, user.permissions);

      setLastPurchaseNumber(purchase.number);
      setLastPurchaseLines(cart);
      setLabelsError(null);
      setCart([]);
      setSupplierId("");
      setAmountPaid("");
      setDueDate("");
      setPaymentMethod("cash");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("purchases.errors.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handlePrintLabels = async () => {
    setLabelsError(null);
    if (lastPurchaseLines.length === 0) return;

    setPrintingLabels(true);
    try {
      const labels = [];
      for (const line of lastPurchaseLines) {
        const product = products.find((p) => p.id === variants.find((v) => v.id === line.variantId)?.productId);
        if (!product) continue;
        const barcode = await ensureVariantBarcode(db, line.variantId);
        // Une étiquette par unité reçue par défaut — copies doit rester un
        // entier positif (quantité d'achat en `real`, potentiellement
        // fractionnaire pour un produit au poids).
        labels.push({
          name: product.name,
          price: product.salePrice,
          barcode,
          copies: Math.max(1, Math.round(line.quantity)),
        });
      }
      const blob = buildLabelSheetPdf(labels);
      await saveGeneratedFile(blob, `etiquettes-${timestampForFilename()}.pdf`);
    } catch (err) {
      setLabelsError(err instanceof Error ? err.message : t("purchases.errors.labelsFailed"));
    } finally {
      setPrintingLabels(false);
    }
  };

  return (
    <main style={pageStyle}>
      <h1>{t("purchases.title")}</h1>

      {lastPurchaseNumber && (
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
            {t("purchases.registered")} <strong>{lastPurchaseNumber}</strong>
          </span>
          <button
            style={{
              ...primaryButtonStyle,
              background: "transparent",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
            }}
            disabled={printingLabels || lastPurchaseLines.length === 0}
            onClick={handlePrintLabels}
          >
            {printingLabels ? t("purchases.printingLabels") : t("purchases.printLabels")}
          </button>
        </div>
      )}
      {labelsError && <p style={{ color: "var(--color-danger)" }}>{labelsError}</p>}

      {lowStockEntries.length > 0 && (
        <div style={{ ...cardStyle, borderLeft: "4px solid #fbbf24", marginTop: 24 }}>
          <strong>{t("purchases.reorderHeading")}</strong>
          <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
            {t("purchases.reorderHint", { days: REORDER_WINDOW_DAYS })}
          </p>
          <div className="table-scroll">
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("purchases.product")}</th>
                  <th style={thStyle}>{t("purchases.currentStock")}</th>
                  <th style={thStyle}>{t("purchases.alertThreshold")}</th>
                  <th style={thStyle}>{t("purchases.suggestedQty")}</th>
                  <th style={thStyle}>{t("purchases.basedOn")}</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {lowStockEntries.map((entry) => (
                  <tr key={entry.product.id}>
                    <td style={tdStyle}>{entry.product.name}</td>
                    <td style={tdStyle}>{entry.totalStock}</td>
                    <td style={tdStyle}>{entry.product.lowStockThreshold}</td>
                    <td style={tdStyle}>{suggestedReorderQuantity(entry)}</td>
                    <td style={tdStyle}>
                      {isPredictedSuggestion(entry)
                        ? t("purchases.basedOnVelocity", { days: REORDER_WINDOW_DAYS })
                        : t("purchases.basedOnThreshold")}
                    </td>
                    <td style={tdStyle}>
                      <button
                        style={{ ...primaryButtonStyle, padding: "4px 12px", fontSize: 13 }}
                        onClick={() => addToCart(entry.product, suggestedReorderQuantity(entry))}
                      >
                        {t("purchases.addToCart")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="cart-layout-grid">
        <div style={cardStyle}>
          <label>
            {t("purchases.supplier")}
            <SearchableSelect
              value={supplierId}
              onChange={setSupplierId}
              options={suppliers.map((s) => ({ value: String(s.id), label: s.name }))}
              emptyLabel={t("purchases.chooseSupplier")}
              placeholder={t("purchases.searchSupplierPlaceholder")}
            />
          </label>
          <label>
            {t("purchases.addItem")}
            <SearchableSelect
              value=""
              onChange={(id) => {
                const product = products.find((p) => p.id === Number(id));
                if (product) addToCart(product);
              }}
              options={products.map((p) => ({ value: String(p.id), label: p.name }))}
              emptyLabel={t("purchases.chooseProduct")}
              placeholder={t("purchases.searchProductPlaceholder")}
            />
          </label>
        </div>

        <div style={cardStyle}>
          <strong>{t("purchases.items")}</strong>
          {cart.length === 0 ? (
            <p style={{ color: "var(--color-text-muted)" }}>{t("purchases.emptyCart")}</p>
          ) : (
            <div className="table-scroll">
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>{t("purchases.item")}</th>
                    <th style={thStyle}>{t("purchases.quantity")}</th>
                    <th style={thStyle}>{t("purchases.unitCost")}</th>
                    <th style={thStyle}>{t("purchases.total")}</th>
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
                      <td style={tdStyle}>
                        <input
                          type="number"
                          value={line.unitCost}
                          onChange={(e) => updateUnitCost(line.variantId, Number(e.target.value))}
                          style={{ ...inputStyle, width: 80, marginTop: 0 }}
                        />
                      </td>
                      <td style={tdStyle}>{(line.quantity * line.unitCost).toFixed(0)}</td>
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

          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12, fontWeight: 700, fontSize: 18 }}>
            {t("purchases.totalLabel")} {total.toFixed(0)}
          </div>

          <label>
            {t("purchases.paymentMethod")}
            <select
              style={inputStyle}
              value={paymentMethod}
              onChange={(e) => handlePaymentMethodChange(e.target.value as PurchasePaymentMethod)}
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            {t("purchases.amountPaid")}
            <input
              style={inputStyle}
              type="number"
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value)}
              placeholder={String(total)}
            />
          </label>

          {willCreateDebt && (
            <label>
              {t("purchases.debtDueDate")}
              <input
                style={inputStyle}
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </label>
          )}

          {error && <p style={{ color: "var(--color-danger)" }}>{error}</p>}

          <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
            {saving ? t("purchases.saving") : t("purchases.submit")}
          </button>
        </div>
      </div>

      <div className="table-scroll">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>{t("purchases.number")}</th>
              <th style={thStyle}>{t("purchases.date")}</th>
              <th style={thStyle}>{t("purchases.supplier")}</th>
              <th style={thStyle}>{t("purchases.total")}</th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <tr key={p.id}>
                <td style={tdStyle}>{p.number}</td>
                <td style={tdStyle}>{p.createdAt}</td>
                <td style={tdStyle}>{supplierName(p.supplierId)}</td>
                <td style={tdStyle}>{p.total}</td>
              </tr>
            ))}
            {purchases.length === 0 && (
              <tr>
                <td style={tdStyle} colSpan={4}>
                  {t("purchases.none")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
