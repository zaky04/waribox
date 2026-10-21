import { breakDownPack, getLocationDisplayName, type StockLevel } from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";
import { variantFullName } from "../../lib/variantLabel";
import { useAuth } from "../auth/useAuth";

type Product = typeof schema.products.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;
type Location = typeof schema.stockLocations.$inferSelect;

interface Props {
  products: Product[];
  variants: Variant[];
  locations: Location[];
  levels: StockLevel[];
  onChanged: () => void | Promise<void>;
}

// « Détailler » : ouvre des boîtes en unités détaillées (plaquettes…). Visible
// seulement quand au moins une présentation détaillée a été définie dans Produits.
export function PackPanel({ products, variants, locations, levels, onChanged }: Props) {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();

  // Boîtes = variantes qui ont au moins une présentation détaillée.
  const parents = useMemo(
    () => variants.filter((v) => variants.some((c) => c.parentVariantId === v.id)),
    [variants],
  );

  const [parentId, setParentId] = useState("");
  const [childId, setChildId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (parents.length === 0) return null;

  const productName = (v: Variant) => products.find((p) => p.id === v.productId)?.name ?? "?";
  const children = variants.filter((c) => c.parentVariantId === Number(parentId));
  const boxesInStock = levels.find((l) => l.variantId === Number(parentId) && l.locationId === Number(locationId))?.quantity ?? 0;

  const handleParentChange = (value: string) => {
    setParentId(value);
    const kids = variants.filter((c) => c.parentVariantId === Number(value));
    setChildId(kids.length === 1 ? String(kids[0]!.id) : "");
  };

  const handleSubmit = async () => {
    setError(null);
    setResult(null);
    if (!parentId || !childId || !locationId || !(Number(quantity) > 0)) {
      setError(t("pharmacy.breakRequired"));
      return;
    }
    setSaving(true);
    try {
      const child = variants.find((c) => c.id === Number(childId));
      await breakDownPack(
        db,
        {
          parentVariantId: Number(parentId),
          childVariantId: Number(childId),
          locationId: Number(locationId),
          quantity: Number(quantity),
          userId: user?.id,
        },
        user?.permissions ?? {},
      );
      setResult(t("pharmacy.breakDone", { boxes: quantity, units: Number(quantity) * (child?.unitsPerParent ?? 0) }));
      setQuantity("1");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pharmacy.breakFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={cardStyle}>
      <strong>{t("pharmacy.breakTitle")}</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("pharmacy.breakHint")}</p>
      <label>
        {t("pharmacy.breakBox")}
        <select style={inputStyle} value={parentId} onChange={(e) => handleParentChange(e.target.value)}>
          <option value="">{t("stock.chooseOption")}</option>
          {parents.map((v) => (
            <option key={v.id} value={v.id}>
              {variantFullName(v, productName(v))}
            </option>
          ))}
        </select>
      </label>
      {parentId && (
        <label>
          {t("pharmacy.breakInto")}
          <select style={inputStyle} value={childId} onChange={(e) => setChildId(e.target.value)}>
            <option value="">{t("stock.chooseOption")}</option>
            {children.map((v) => (
              <option key={v.id} value={v.id}>
                {variantFullName(v, productName(v))} — {t("pharmacy.unitsPerBox", { count: v.unitsPerParent ?? 0 })}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t("stock.location")}
        <select style={inputStyle} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">{t("stock.chooseOption")}</option>
          {locations.map((loc) => (
            <option key={loc.id} value={loc.id}>
              {getLocationDisplayName(loc.name)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("pharmacy.breakQuantity")}
        {parentId && locationId ? ` (${t("pharmacy.boxesInStock", { count: boxesInStock })})` : ""}
        <input style={inputStyle} type="number" min={1} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </label>
      {error && <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{error}</p>}
      {result && <p style={{ color: "var(--color-success)", fontSize: 13, margin: 0 }}>{result}</p>}
      <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
        {saving ? t("pharmacy.breaking") : t("pharmacy.breakSubmit")}
      </button>
    </div>
  );
}
