import {
  listAllVariants,
  listProducts,
  listPurchases,
  listSupplierDebts,
  listSuppliers,
  recordDebtPayment,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
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
import { useAuth } from "../auth/useAuth";

type Debt = typeof schema.supplierDebts.$inferSelect;
type Supplier = typeof schema.suppliers.$inferSelect;
type Purchase = typeof schema.purchases.$inferSelect;
type PurchaseItem = typeof schema.purchaseItems.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;
type Product = typeof schema.products.$inferSelect;

const STATUS_LABELS: Record<string, string> = {
  open: "Ouverte",
  partial: "Partielle",
  settled: "Soldée",
};

export function DebtsPage() {
  const db = useDatabase();
  const { user } = useAuth();

  const [debts, setDebts] = useState<Debt[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [purchaseItems, setPurchaseItems] = useState<PurchaseItem[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [showSettled, setShowSettled] = useState(false);

  const [payingId, setPayingId] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [debtRows, supplierRows, purchaseRows, purchaseItemRows, variantRows, productRows] =
      await Promise.all([
        listSupplierDebts(db),
        listSuppliers(db),
        listPurchases(db),
        db.select().from(schema.purchaseItems),
        listAllVariants(db),
        listProducts(db),
      ]);
    setDebts(debtRows);
    setSuppliers(supplierRows);
    setPurchases(purchaseRows);
    setPurchaseItems(purchaseItemRows);
    setVariants(variantRows);
    setProducts(productRows);
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const supplierName = (id: number) => suppliers.find((s) => s.id === id)?.name ?? "—";
  const purchaseNumber = (id: number | null) => purchases.find((p) => p.id === id)?.number ?? "—";
  const articleSummary = (purchaseId: number | null) => {
    if (!purchaseId) return "—";
    const names = purchaseItems
      .filter((i) => i.purchaseId === purchaseId)
      .map((i) => {
        const variant = variants.find((v) => v.id === i.variantId);
        const product = variant ? products.find((p) => p.id === variant.productId) : undefined;
        return product?.name ?? "Article";
      });
    return names.length > 0 ? names.join(", ") : "—";
  };

  const visibleDebts = debts.filter((d) => showSettled || d.status !== "settled");

  const startPayment = (debt: Debt) => {
    setPayingId(debt.id);
    setAmount(String(debt.remainingBalance));
    setError(null);
  };

  const handleSubmit = async (debt: Debt) => {
    setError(null);
    if (!user) return;
    const value = Number(amount);
    if (!value || value <= 0) {
      setError("Le montant doit être supérieur à zéro.");
      return;
    }

    setSaving(true);
    try {
      await recordDebtPayment(db, { debtId: debt.id, amount: value, userId: user.id });
      setPayingId(null);
      setAmount("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible d'enregistrer le paiement.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Dettes</h1>
        <button
          style={{
            ...primaryButtonStyle,
            background: showSettled ? "var(--gradient-accent)" : "transparent",
            color: showSettled ? "#0f172a" : "var(--color-text)",
            border: showSettled ? "none" : "1px solid var(--color-border)",
          }}
          onClick={() => setShowSettled((v) => !v)}
        >
          {showSettled ? "Masquer les soldées" : "Afficher les soldées"}
        </button>
      </div>

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Date</th>
            <th style={thStyle}>Fournisseur</th>
            <th style={thStyle}>Achat</th>
            <th style={thStyle}>Article</th>
            <th style={thStyle}>Montant initial</th>
            <th style={thStyle}>Solde restant</th>
            <th style={thStyle}>Statut</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {visibleDebts.map((debt) => (
            <tr key={debt.id}>
              <td style={tdStyle}>{debt.createdAt}</td>
              <td style={tdStyle}>{supplierName(debt.supplierId)}</td>
              <td style={tdStyle}>{purchaseNumber(debt.purchaseId)}</td>
              <td style={tdStyle}>{articleSummary(debt.purchaseId)}</td>
              <td style={tdStyle}>{debt.originalAmount}</td>
              <td style={tdStyle}>{debt.remainingBalance}</td>
              <td style={tdStyle}>
                <span style={badgeStyle(debt.status === "settled" ? "ok" : "warning")}>
                  {STATUS_LABELS[debt.status] ?? debt.status}
                </span>
              </td>
              <td style={tdStyle}>
                {debt.status !== "settled" &&
                  (payingId === debt.id ? (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        type="number"
                        style={{ ...inputStyle, width: 90, marginTop: 0 }}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                      />
                      <button
                        style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                        onClick={() => handleSubmit(debt)}
                        disabled={saving}
                      >
                        Valider
                      </button>
                      <button
                        style={{ background: "transparent", border: "none", color: "var(--color-text-muted)", cursor: "pointer" }}
                        onClick={() => setPayingId(null)}
                      >
                        Annuler
                      </button>
                    </div>
                  ) : (
                    <button
                      style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 14 }}
                      onClick={() => startPayment(debt)}
                    >
                      Enregistrer un paiement
                    </button>
                  ))}
              </td>
            </tr>
          ))}
          {visibleDebts.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={8}>
                Aucune dette.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {error && <p style={{ color: "#f87171" }}>{error}</p>}
    </main>
  );
}
