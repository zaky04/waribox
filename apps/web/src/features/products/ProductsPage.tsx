import {
  createCategory,
  createProduct,
  ensureVariantBarcode,
  getSettings,
  getStockLevels,
  hasPermission,
  listAllVariants,
  listCategories,
  listProducts,
  updateProduct,
  updateVariantBarcode,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { buildLabelSheetPdf } from "@gestion-boutique/printer";
import { useCallback, useEffect, useState } from "react";
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
type Category = typeof schema.categories.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;

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

export function ProductsPage() {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();
  const canManage = hasPermission(user?.permissions ?? {}, "manage_products");
  const canViewMargins = hasPermission(user?.permissions ?? {}, "view_margins");

  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [stockByVariant, setStockByVariant] = useState<Map<number, number>>(new Map());
  const [businessSettings, setBusinessSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(
    null,
  );

  const [showForm, setShowForm] = useState(false);
  const [editingProductId, setEditingProductId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [unit, setUnit] = useState("unite");
  const [purchasePrice, setPurchasePrice] = useState("0");
  const [salePrice, setSalePrice] = useState("0");
  const [lowStockThreshold, setLowStockThreshold] = useState("5");
  const [trackExpiry, setTrackExpiry] = useState(false);
  const [taxRate, setTaxRate] = useState("");
  const [barcode, setBarcode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [labelQuantities, setLabelQuantities] = useState<Record<number, string>>({});
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [printingLabels, setPrintingLabels] = useState(false);

  const refresh = useCallback(async () => {
    const [productsRows, categoriesRows, variantsRows, levels, settings] = await Promise.all([
      listProducts(db),
      listCategories(db),
      listAllVariants(db),
      getStockLevels(db),
      getSettings(db),
    ]);
    setProducts(productsRows);
    setCategories(categoriesRows);
    setVariants(variantsRows);
    setBusinessSettings(settings);

    const byVariant = new Map<number, number>();
    for (const level of levels) {
      byVariant.set(level.variantId, (byVariant.get(level.variantId) ?? 0) + level.quantity);
    }
    setStockByVariant(byVariant);
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const productStock = (productId: number) =>
    variants
      .filter((v) => v.productId === productId)
      .reduce((sum, v) => sum + (stockByVariant.get(v.id) ?? 0), 0);

  const resetForm = () => {
    setEditingProductId(null);
    setName("");
    setCategoryId("");
    setNewCategoryName("");
    setUnit("unite");
    setPurchasePrice("0");
    setSalePrice("0");
    setLowStockThreshold("5");
    setTrackExpiry(false);
    setTaxRate("");
    setBarcode("");
    setError(null);
    setShowForm(false);
  };

  const startEdit = (product: Product) => {
    const variant = variants.find((v) => v.productId === product.id);
    setEditingProductId(product.id);
    setName(product.name);
    setCategoryId(product.categoryId ? String(product.categoryId) : "");
    setNewCategoryName("");
    setUnit(product.unit);
    setPurchasePrice(String(product.purchasePrice));
    setSalePrice(String(product.salePrice));
    setLowStockThreshold(String(product.lowStockThreshold));
    setTrackExpiry(product.trackExpiry);
    setTaxRate(product.taxRate === null ? "" : String(product.taxRate));
    setBarcode(variant?.barcode ?? "");
    setError(null);
    setShowForm(true);
  };

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) {
      setError(t("products.errors.nameRequired"));
      return;
    }

    setSaving(true);
    try {
      const permissions = user?.permissions ?? {};
      let finalCategoryId = categoryId ? Number(categoryId) : null;
      if (!finalCategoryId && newCategoryName.trim()) {
        const created = await createCategory(db, { name: newCategoryName.trim(), createdBy: user?.id }, permissions);
        finalCategoryId = created.id;
      }

      if (editingProductId) {
        await updateProduct(db, editingProductId, {
          name: name.trim(),
          categoryId: finalCategoryId,
          unit,
          purchasePrice: Number(purchasePrice) || 0,
          salePrice: Number(salePrice) || 0,
          lowStockThreshold: Number(lowStockThreshold) || 0,
          trackExpiry,
          taxRate: taxRate.trim() === "" ? null : Number(taxRate),
          updatedBy: user?.id,
        }, permissions);
        const variant = variants.find((v) => v.productId === editingProductId);
        if (variant) {
          await updateVariantBarcode(db, variant.id, barcode.trim() || null, permissions);
        }
      } else {
        await createProduct(db, {
          name: name.trim(),
          categoryId: finalCategoryId,
          unit,
          purchasePrice: Number(purchasePrice) || 0,
          salePrice: Number(salePrice) || 0,
          lowStockThreshold: Number(lowStockThreshold) || 0,
          trackExpiry,
          taxRate: taxRate.trim() === "" ? null : Number(taxRate),
          barcode: barcode.trim() || null,
          createdBy: user?.id,
        }, permissions);
      }

      resetForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("products.errors.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handlePrintLabels = async () => {
    setLabelsError(null);
    const entries = Object.entries(labelQuantities)
      .map(([productId, qty]) => ({ productId: Number(productId), copies: Number(qty) }))
      .filter((e) => e.copies > 0);
    if (entries.length === 0) {
      setLabelsError(t("products.errors.labelsQuantityRequired"));
      return;
    }

    setPrintingLabels(true);
    try {
      const labels = [];
      for (const entry of entries) {
        const product = products.find((p) => p.id === entry.productId);
        const variant = variants.find((v) => v.productId === entry.productId);
        if (!product || !variant) continue;
        const barcode = await ensureVariantBarcode(db, variant.id);
        labels.push({ name: product.name, price: product.salePrice, barcode, copies: entry.copies });
      }
      const blob = buildLabelSheetPdf(labels);
      downloadBlob(blob, `etiquettes-${timestampForFilename()}.pdf`);
      setLabelQuantities({});
      await refresh();
    } catch (err) {
      setLabelsError(err instanceof Error ? err.message : t("products.errors.labelsFailed"));
    } finally {
      setPrintingLabels(false);
    }
  };

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>{t("products.title")}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={primaryButtonStyle} onClick={handlePrintLabels} disabled={printingLabels}>
            {printingLabels ? t("products.printingLabels") : t("products.printLabels")}
          </button>
          {canManage && (
            <button style={primaryButtonStyle} onClick={() => (showForm ? resetForm() : setShowForm(true))}>
              {showForm ? t("products.cancel") : t("products.new")}
            </button>
          )}
        </div>
      </div>
      {labelsError && <p style={{ color: "#f87171" }}>{labelsError}</p>}

      {showForm && (
        <div style={cardStyle}>
          <h2 style={{ margin: 0 }}>{editingProductId ? t("products.editTitle") : t("products.newTitle")}</h2>
          <label>
            {t("products.name")}
            <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label>
            {t("products.existingCategory")}
            <SearchableSelect
              value={categoryId}
              onChange={setCategoryId}
              options={categories.map((c) => ({ value: String(c.id), label: c.name }))}
              emptyLabel={t("products.noCategoryOption")}
              placeholder={t("products.searchCategoryPlaceholder")}
            />
          </label>

          <label>
            {t("products.orNewCategory")}
            <input
              style={inputStyle}
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder={t("products.newCategoryPlaceholder")}
              disabled={!!categoryId}
            />
          </label>

          <label>
            {t("products.unit")}
            <input style={inputStyle} value={unit} onChange={(e) => setUnit(e.target.value)} />
          </label>

          <div style={{ display: "flex", gap: 16 }}>
            <label style={{ flex: 1 }}>
              {t("products.purchasePrice")}
              <input
                style={inputStyle}
                type="number"
                value={purchasePrice}
                onChange={(e) => setPurchasePrice(e.target.value)}
              />
            </label>
            <label style={{ flex: 1 }}>
              {t("products.salePrice")}
              <input
                style={inputStyle}
                type="number"
                value={salePrice}
                onChange={(e) => setSalePrice(e.target.value)}
              />
            </label>
          </div>

          <label>
            {t("products.lowStockThreshold")}
            <input
              style={inputStyle}
              type="number"
              value={lowStockThreshold}
              onChange={(e) => setLowStockThreshold(e.target.value)}
            />
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={trackExpiry}
              onChange={(e) => setTrackExpiry(e.target.checked)}
            />
            {t("products.trackExpiry")}
          </label>

          {businessSettings?.taxEnabled && (
            <label>
              {t("products.taxRate", { rate: businessSettings.defaultTaxRate })}
              <input
                style={inputStyle}
                type="number"
                min={0}
                max={99}
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
                placeholder={String(businessSettings.defaultTaxRate)}
              />
            </label>
          )}

          <label>
            {t("products.barcode")}
            <input
              style={inputStyle}
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder={t("products.barcodePlaceholder")}
            />
          </label>

          {error && <p style={{ color: "#f87171" }}>{error}</p>}

          <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
            {saving ? t("products.saving") : editingProductId ? t("products.saveChanges") : t("products.create")}
          </button>
        </div>
      )}

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>{t("products.name")}</th>
            <th style={thStyle}>{t("products.category")}</th>
            {canViewMargins && <th style={thStyle}>{t("products.purchase")}</th>}
            <th style={thStyle}>{t("products.sale")}</th>
            <th style={thStyle}>{t("products.stock")}</th>
            <th style={thStyle}>{t("products.labels")}</th>
            {canManage && <th style={thStyle}></th>}
          </tr>
        </thead>
        <tbody>
          {products.map((product) => {
            const stock = productStock(product.id);
            const isLow = stock <= product.lowStockThreshold;
            const category = categories.find((c) => c.id === product.categoryId);
            return (
              <tr key={product.id}>
                <td style={tdStyle}>{product.name}</td>
                <td style={tdStyle}>{category?.name ?? "—"}</td>
                {canViewMargins && <td style={tdStyle}>{product.purchasePrice}</td>}
                <td style={tdStyle}>{product.salePrice}</td>
                <td style={tdStyle}>
                  <span style={badgeStyle(isLow ? "warning" : "ok")}>{stock}</span>
                </td>
                <td style={tdStyle}>
                  <input
                    type="number"
                    min={0}
                    value={labelQuantities[product.id] ?? ""}
                    onChange={(e) =>
                      setLabelQuantities((prev) => ({ ...prev, [product.id]: e.target.value }))
                    }
                    placeholder="0"
                    style={{ ...inputStyle, width: 60, marginTop: 0 }}
                  />
                </td>
                {canManage && (
                  <td style={tdStyle}>
                    <button
                      style={{
                        background: "transparent",
                        border: "1px solid var(--color-border)",
                        color: "var(--color-text)",
                        borderRadius: 8,
                        padding: "6px 12px",
                        cursor: "pointer",
                      }}
                      onClick={() => startEdit(product)}
                    >
                      {t("products.edit")}
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
          {products.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={(canViewMargins ? 6 : 5) + (canManage ? 1 : 0)}>
                {t("products.none")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
