import {
  createCategory,
  createProduct,
  ensureVariantBarcode,
  getStockLevels,
  hasPermission,
  listAllVariants,
  listCategories,
  listProducts,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { buildLabelSheetPdf } from "@gestion-boutique/printer";
import { useCallback, useEffect, useState } from "react";
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
  const canManage = hasPermission(user?.permissions ?? {}, "manage_products");
  const canViewMargins = hasPermission(user?.permissions ?? {}, "view_margins");

  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [stockByVariant, setStockByVariant] = useState<Map<number, number>>(new Map());

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [unit, setUnit] = useState("unite");
  const [purchasePrice, setPurchasePrice] = useState("0");
  const [salePrice, setSalePrice] = useState("0");
  const [lowStockThreshold, setLowStockThreshold] = useState("5");
  const [trackExpiry, setTrackExpiry] = useState(false);
  const [barcode, setBarcode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [labelQuantities, setLabelQuantities] = useState<Record<number, string>>({});
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [printingLabels, setPrintingLabels] = useState(false);

  const refresh = useCallback(async () => {
    const [productsRows, categoriesRows, variantsRows, levels] = await Promise.all([
      listProducts(db),
      listCategories(db),
      listAllVariants(db),
      getStockLevels(db),
    ]);
    setProducts(productsRows);
    setCategories(categoriesRows);
    setVariants(variantsRows);

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

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Le nom du produit est requis.");
      return;
    }

    setSaving(true);
    try {
      let finalCategoryId = categoryId ? Number(categoryId) : null;
      if (!finalCategoryId && newCategoryName.trim()) {
        const created = await createCategory(db, { name: newCategoryName.trim(), createdBy: user?.id });
        finalCategoryId = created.id;
      }

      await createProduct(db, {
        name: name.trim(),
        categoryId: finalCategoryId,
        unit,
        purchasePrice: Number(purchasePrice) || 0,
        salePrice: Number(salePrice) || 0,
        lowStockThreshold: Number(lowStockThreshold) || 0,
        trackExpiry,
        barcode: barcode.trim() || null,
        createdBy: user?.id,
      });

      setName("");
      setCategoryId("");
      setNewCategoryName("");
      setUnit("unite");
      setPurchasePrice("0");
      setSalePrice("0");
      setLowStockThreshold("5");
      setTrackExpiry(false);
      setBarcode("");
      setShowForm(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible de créer le produit.");
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
      setLabelsError("Indique une quantité d'étiquettes pour au moins un produit.");
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
      setLabelsError(err instanceof Error ? err.message : "Impossible de générer les étiquettes.");
    } finally {
      setPrintingLabels(false);
    }
  };

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Produits</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={primaryButtonStyle} onClick={handlePrintLabels} disabled={printingLabels}>
            {printingLabels ? "Génération..." : "Imprimer les étiquettes sélectionnées"}
          </button>
          {canManage && (
            <button style={primaryButtonStyle} onClick={() => setShowForm((v) => !v)}>
              {showForm ? "Annuler" : "+ Nouveau produit"}
            </button>
          )}
        </div>
      </div>
      {labelsError && <p style={{ color: "#f87171" }}>{labelsError}</p>}

      {showForm && (
        <div style={cardStyle}>
          <label>
            Nom du produit
            <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label>
            Catégorie existante
            <SearchableSelect
              value={categoryId}
              onChange={setCategoryId}
              options={categories.map((c) => ({ value: String(c.id), label: c.name }))}
              emptyLabel="— Aucune —"
              placeholder="Rechercher une catégorie..."
            />
          </label>

          <label>
            Ou nouvelle catégorie
            <input
              style={inputStyle}
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder="ex: Épicerie"
              disabled={!!categoryId}
            />
          </label>

          <label>
            Unité
            <input style={inputStyle} value={unit} onChange={(e) => setUnit(e.target.value)} />
          </label>

          <div style={{ display: "flex", gap: 16 }}>
            <label style={{ flex: 1 }}>
              Prix d'achat
              <input
                style={inputStyle}
                type="number"
                value={purchasePrice}
                onChange={(e) => setPurchasePrice(e.target.value)}
              />
            </label>
            <label style={{ flex: 1 }}>
              Prix de vente
              <input
                style={inputStyle}
                type="number"
                value={salePrice}
                onChange={(e) => setSalePrice(e.target.value)}
              />
            </label>
          </div>

          <label>
            Seuil d'alerte stock bas
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
            Produit périssable (suivi de péremption)
          </label>

          <label>
            Code-barres (optionnel)
            <input
              style={inputStyle}
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder="Scanne avec la douchette ou saisis manuellement"
            />
          </label>

          {error && <p style={{ color: "#f87171" }}>{error}</p>}

          <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
            {saving ? "Création..." : "Créer le produit"}
          </button>
        </div>
      )}

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Nom</th>
            <th style={thStyle}>Catégorie</th>
            {canViewMargins && <th style={thStyle}>Achat</th>}
            <th style={thStyle}>Vente</th>
            <th style={thStyle}>Stock</th>
            <th style={thStyle}>Étiquettes</th>
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
              </tr>
            );
          })}
          {products.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={canViewMargins ? 6 : 5}>
                Aucun produit pour le moment.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
