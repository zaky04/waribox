import {
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

type Credit = typeof schema.customerCredits.$inferSelect;
type Customer = typeof schema.customers.$inferSelect;
type Sale = typeof schema.sales.$inferSelect;
type ServiceOrder = typeof schema.serviceOrders.$inferSelect;
type SaleItem = typeof schema.saleItems.$inferSelect;
type ServiceOrderItem = typeof schema.serviceOrderItems.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;
type Product = typeof schema.products.$inferSelect;

const STATUS_LABELS: Record<string, string> = {
  open: "Ouverte",
  partial: "Partielle",
  settled: "Soldée",
};

export function CreditsPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();

  const [credits, setCredits] = useState<Credit[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [serviceOrders, setServiceOrders] = useState<ServiceOrder[]>([]);
  const [saleItems, setSaleItems] = useState<SaleItem[]>([]);
  const [serviceOrderItems, setServiceOrderItems] = useState<ServiceOrderItem[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [showSettled, setShowSettled] = useState(false);

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
    ] = await Promise.all([
      listCustomerCredits(db, currentStoreId ?? undefined),
      listCustomers(db),
      listSales(db),
      listServiceOrders(db),
      db.select().from(schema.saleItems),
      db.select().from(schema.serviceOrderItems),
      listAllVariants(db),
      listProducts(db),
    ]);
    setCredits(creditRows);
    setCustomers(customerRows);
    setSales(saleRows);
    setServiceOrders(serviceOrderRows);
    setSaleItems(saleItemRows);
    setServiceOrderItems(serviceOrderItemRows);
    setVariants(variantRows);
    setProducts(productRows);
  }, [db, currentStoreId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const customerName = (id: number) => customers.find((c) => c.id === id)?.fullName ?? "—";
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
      setError("Le montant doit être supérieur à zéro.");
      return;
    }

    setSaving(true);
    try {
      await recordCreditRepayment(db, { creditId: credit.id, amount: value, userId: user.id });
      setPayingId(null);
      setAmount("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible d'enregistrer le remboursement.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Créances</h1>
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
            <th style={thStyle}>Client</th>
            <th style={thStyle}>Référence</th>
            <th style={thStyle}>Article</th>
            <th style={thStyle}>Montant initial</th>
            <th style={thStyle}>Solde restant</th>
            <th style={thStyle}>Statut</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {visibleCredits.map((credit) => (
            <tr key={credit.id}>
              <td style={tdStyle}>{credit.createdAt}</td>
              <td style={tdStyle}>{customerName(credit.customerId)}</td>
              <td style={tdStyle}>{referenceNumber(credit)}</td>
              <td style={tdStyle}>{articleSummary(credit)}</td>
              <td style={tdStyle}>{credit.originalAmount}</td>
              <td style={tdStyle}>{credit.remainingBalance}</td>
              <td style={tdStyle}>
                <span style={badgeStyle(credit.status === "settled" ? "ok" : "warning")}>
                  {STATUS_LABELS[credit.status] ?? credit.status}
                </span>
              </td>
              <td style={tdStyle}>
                {credit.status !== "settled" &&
                  (payingId === credit.id ? (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
                      onClick={() => startPayment(credit)}
                    >
                      Enregistrer un paiement
                    </button>
                  ))}
              </td>
            </tr>
          ))}
          {visibleCredits.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={8}>
                Aucune créance.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {error && <p style={{ color: "#f87171" }}>{error}</p>}
    </main>
  );
}
