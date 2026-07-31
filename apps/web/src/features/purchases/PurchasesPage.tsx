import {
  createPurchase,
  listAllVariants,
  listProducts,
  listPurchases,
  listSuppliers,
  type PurchasePaymentMethod,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
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

const PAYMENT_METHODS: { value: PurchasePaymentMethod; label: string }[] = [
  { value: "cash", label: "Espèces" },
  { value: "card", label: "Carte" },
  { value: "mobile_money", label: "Mobile Money" },
  { value: "credit", label: "Crédit" },
];

export function PurchasesPage() {
  const db = useDatabase();
  const { user } = useAuth();

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);

  const [supplierId, setSupplierId] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PurchasePaymentMethod>("cash");
  const [amountPaid, setAmountPaid] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastPurchaseNumber, setLastPurchaseNumber] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [supplierRows, productRows, variantRows, purchaseRows] = await Promise.all([
      listSuppliers(db),
      listProducts(db),
      listAllVariants(db),
      listPurchases(db),
    ]);
    setSuppliers(supplierRows);
    setProducts(productRows);
    setVariants(variantRows);
    setPurchases(purchaseRows);
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
          quantity: 1,
          unitCost: product.purchasePrice,
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
    if (!user) return;
    if (!supplierId) {
      setError("Choisis un fournisseur.");
      return;
    }
    if (cart.length === 0) {
      setError("Ajoute au moins un article.");
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
      });

      setLastPurchaseNumber(purchase.number);
      setCart([]);
      setSupplierId("");
      setAmountPaid("");
      setDueDate("");
      setPaymentMethod("cash");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible d'enregistrer l'achat.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main style={pageStyle}>
      <h1>Achats</h1>

      {lastPurchaseNumber && (
        <div style={{ ...cardStyle, borderLeft: "4px solid #86efac" }}>
          Achat enregistré : <strong>{lastPurchaseNumber}</strong>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 24, marginTop: 24 }}>
        <div style={cardStyle}>
          <label>
            Fournisseur
            <SearchableSelect
              value={supplierId}
              onChange={setSupplierId}
              options={suppliers.map((s) => ({ value: String(s.id), label: s.name }))}
              emptyLabel="— Choisir un fournisseur —"
              placeholder="Rechercher un fournisseur..."
            />
          </label>
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

        <div style={cardStyle}>
          <strong>Articles</strong>
          {cart.length === 0 ? (
            <p style={{ color: "var(--color-text-muted)" }}>Aucun article.</p>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Article</th>
                  <th style={thStyle}>Qté</th>
                  <th style={thStyle}>Coût unit.</th>
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

          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12, fontWeight: 700, fontSize: 18 }}>
            Total : {total.toFixed(0)}
          </div>

          <label>
            Méthode de paiement
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
            Montant payé
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
              Échéance de la dette (optionnel)
              <input
                style={inputStyle}
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </label>
          )}

          {error && <p style={{ color: "#f87171" }}>{error}</p>}

          <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
            {saving ? "Enregistrement..." : "Enregistrer l'achat"}
          </button>
        </div>
      </div>

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Numéro</th>
            <th style={thStyle}>Date</th>
            <th style={thStyle}>Fournisseur</th>
            <th style={thStyle}>Total</th>
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
                Aucun achat pour le moment.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
