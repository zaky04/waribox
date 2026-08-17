import {
  createPromotion,
  deletePromotion,
  isPromotionActiveOn,
  listPromotionProducts,
  listPromotions,
  listProducts,
  updatePromotion,
  type PromotionScope,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
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

type Promotion = typeof schema.promotions.$inferSelect;
type Product = typeof schema.products.$inferSelect;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const secondaryButtonStyle = {
  ...primaryButtonStyle,
  background: "transparent",
  border: "1px solid var(--color-border)",
  color: "var(--color-text)",
  padding: "6px 12px",
  fontSize: 14,
};

export function PromotionsPage() {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();

  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  // productId -> promotionId[] concernées, pour affichage dans la liste
  const [productsByPromotion, setProductsByPromotion] = useState<Record<number, number[]>>({});

  const [name, setName] = useState("");
  const [scope, setScope] = useState<PromotionScope>("product");
  const [discountPercent, setDiscountPercent] = useState("10");
  const [startDate, setStartDate] = useState(isoDate(new Date()));
  const [endDate, setEndDate] = useState(isoDate(new Date()));
  const [selectedProductIds, setSelectedProductIds] = useState<number[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [promotionRows, productRows] = await Promise.all([listPromotions(db), listProducts(db)]);
    setPromotions(promotionRows);
    setProducts(productRows);
    const links = await Promise.all(
      promotionRows
        .filter((p) => p.scope === "product")
        .map(async (p) => [p.id, (await listPromotionProducts(db, p.id)).map((l) => l.productId)] as const),
    );
    setProductsByPromotion(Object.fromEntries(links));
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const resetForm = () => {
    setName("");
    setScope("product");
    setDiscountPercent("10");
    setStartDate(isoDate(new Date()));
    setEndDate(isoDate(new Date()));
    setSelectedProductIds([]);
    setProductSearch("");
  };

  const toggleProduct = (productId: number) => {
    setSelectedProductIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId],
    );
  };

  const handleCreate = async () => {
    setError(null);
    const percent = Number(discountPercent);
    if (!name.trim()) {
      setError(t("promotions.errors.nameRequired"));
      return;
    }
    if (!(percent > 0 && percent <= 100)) {
      setError(t("promotions.errors.percentRange"));
      return;
    }
    if (startDate > endDate) {
      setError(t("promotions.errors.dateOrder"));
      return;
    }
    if (scope === "product" && selectedProductIds.length === 0) {
      setError(t("promotions.errors.productsRequired"));
      return;
    }

    setSaving(true);
    try {
      await createPromotion(
        db,
        {
          name: name.trim(),
          scope,
          discountPercent: percent,
          startDate,
          endDate,
          productIds: scope === "product" ? selectedProductIds : undefined,
        },
        user?.permissions ?? {},
      );
      resetForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("promotions.errors.createFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (promotion: Promotion) => {
    await updatePromotion(db, promotion.id, { isActive: !promotion.isActive }, user?.permissions ?? {});
    await refresh();
  };

  const handleDelete = async (promotion: Promotion) => {
    await deletePromotion(db, promotion.id, user?.permissions ?? {});
    await refresh();
  };

  const productName = (id: number) => products.find((p) => p.id === id)?.name ?? "—";
  const filteredProducts = products.filter((p) =>
    p.name.toLowerCase().includes(productSearch.trim().toLowerCase()),
  );
  const today = isoDate(new Date());

  return (
    <main style={pageStyle}>
      <h1>{t("promotions.title")}</h1>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{t("promotions.hint")}</p>

      <div style={cardStyle}>
        <strong>{t("promotions.newHeading")}</strong>
        <label>
          {t("promotions.name")}
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("promotions.namePlaceholder")} />
        </label>
        <label>
          {t("promotions.scope")}
          <select style={inputStyle} value={scope} onChange={(e) => setScope(e.target.value as PromotionScope)}>
            <option value="product">{t("promotions.scopeProduct")}</option>
            <option value="invoice">{t("promotions.scopeInvoice")}</option>
          </select>
        </label>
        <label>
          {t("promotions.discountPercent")}
          <input
            style={inputStyle}
            type="number"
            min="1"
            max="100"
            value={discountPercent}
            onChange={(e) => setDiscountPercent(e.target.value)}
          />
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <label style={{ flex: 1 }}>
            {t("promotions.from")}
            <input style={inputStyle} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label style={{ flex: 1 }}>
            {t("promotions.to")}
            <input style={inputStyle} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
        </div>

        {scope === "product" && (
          <div>
            <label>
              {t("promotions.concernedProducts")}
              <input
                style={inputStyle}
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder={t("promotions.searchProductPlaceholder")}
              />
            </label>
            <div
              style={{
                maxHeight: 180,
                overflowY: "auto",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                padding: 8,
                marginTop: 4,
              }}
            >
              {filteredProducts.map((product) => (
                <label key={product.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
                  <input
                    type="checkbox"
                    checked={selectedProductIds.includes(product.id)}
                    onChange={() => toggleProduct(product.id)}
                  />
                  {product.name}
                </label>
              ))}
              {filteredProducts.length === 0 && (
                <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("promotions.noProducts")}</p>
              )}
            </div>
            {selectedProductIds.length > 0 && (
              <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
                {t("promotions.selectedCount", { count: selectedProductIds.length })}
              </p>
            )}
          </div>
        )}

        {error && <p style={{ color: "#f87171" }}>{error}</p>}

        <button style={primaryButtonStyle} onClick={handleCreate} disabled={saving}>
          {saving ? t("promotions.creating") : t("promotions.create")}
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>{t("promotions.name")}</th>
              <th style={thStyle}>{t("promotions.scopeColumn")}</th>
              <th style={thStyle}>{t("promotions.discount")}</th>
              <th style={thStyle}>{t("promotions.period")}</th>
              <th style={thStyle}>{t("promotions.status")}</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {promotions.map((promo) => {
              const running = isPromotionActiveOn(promo, today);
              return (
                <tr key={promo.id}>
                  <td style={tdStyle}>
                    {promo.name}
                    {promo.scope === "product" && (
                      <div style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                        {(productsByPromotion[promo.id] ?? []).map(productName).join(", ") || t("promotions.noProductsLinked")}
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>{promo.scope === "product" ? t("promotions.scopeProductShort") : t("promotions.scopeInvoiceShort")}</td>
                  <td style={tdStyle}>-{promo.discountPercent}%</td>
                  <td style={tdStyle}>
                    {promo.startDate} → {promo.endDate}
                  </td>
                  <td style={tdStyle}>
                    <span style={badgeStyle(!promo.isActive ? "info" : running ? "ok" : "warning")}>
                      {!promo.isActive ? t("promotions.disabled") : running ? t("promotions.running") : t("promotions.scheduledOrExpired")}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <button style={secondaryButtonStyle} onClick={() => handleToggleActive(promo)}>
                        {promo.isActive ? t("promotions.disable") : t("promotions.enable")}
                      </button>
                      <button style={secondaryButtonStyle} onClick={() => handleDelete(promo)}>
                        {t("promotions.delete")}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {promotions.length === 0 && (
              <tr>
                <td style={tdStyle} colSpan={6}>
                  {t("promotions.none")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
