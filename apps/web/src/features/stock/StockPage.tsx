import {
  createBatch,
  getLowStockProducts,
  getSettings,
  getStockLevels,
  hasPermission,
  listAllVariants,
  listExpiringBatches,
  listLocations,
  listProducts,
  recordMovement,
  transferStock,
  type ExpiringBatch,
  type LowStockEntry,
  type StockLevel,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDatabase } from "../../app/DatabaseProvider";
import { FilterBar } from "../../components/FilterBar";
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
import { openExternalUrl } from "../../lib/openExternalUrl";
import { buildWhatsAppLink } from "../../lib/whatsapp";
import { useAuth } from "../auth/useAuth";

type Product = typeof schema.products.$inferSelect;
type Variant = typeof schema.productVariants.$inferSelect;
type Location = typeof schema.stockLocations.$inferSelect;

const EXPIRY_WARNING_DAYS = 14;

const LOSS_REASONS: { value: string; label: string }[] = [
  { value: "expiry", label: "Péremption" },
  { value: "damage", label: "Casse / Destruction" },
  { value: "theft", label: "Vol" },
  { value: "other", label: "Autre" },
];

export function StockPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const canManage = hasPermission(user?.permissions ?? {}, "manage_stock");

  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [levels, setLevels] = useState<StockLevel[]>([]);
  const [lowStock, setLowStock] = useState<LowStockEntry[]>([]);
  const [expiring, setExpiring] = useState<ExpiringBatch[]>([]);
  const [businessSettings, setBusinessSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(null);

  const [variantId, setVariantId] = useState<string>("");
  const [entryLocationId, setEntryLocationId] = useState<string>("");
  const [entryQuantity, setEntryQuantity] = useState("0");
  const [lotNumber, setLotNumber] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [entryError, setEntryError] = useState<string | null>(null);
  const [entrySaving, setEntrySaving] = useState(false);

  const [transferVariantId, setTransferVariantId] = useState<string>("");
  const [fromLocationId, setFromLocationId] = useState<string>("");
  const [toLocationId, setToLocationId] = useState<string>("");
  const [transferQuantity, setTransferQuantity] = useState("0");
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferSaving, setTransferSaving] = useState(false);

  const [lossVariantId, setLossVariantId] = useState<string>("");
  const [lossLocationId, setLossLocationId] = useState<string>("");
  const [lossQuantity, setLossQuantity] = useState("0");
  const [lossReason, setLossReason] = useState(LOSS_REASONS[0]!.value);
  const [lossError, setLossError] = useState<string | null>(null);
  const [lossSaving, setLossSaving] = useState(false);

  const [search, setSearch] = useState("");
  const [filterLocationId, setFilterLocationId] = useState("");
  const [lowStockOnly, setLowStockOnly] = useState(false);

  const refresh = useCallback(async () => {
    const storeId = currentStoreId ?? undefined;
    const [productsRows, variantsRows, locationsRows, levelsRows, lowStockRows, expiringRows, settings] =
      await Promise.all([
        listProducts(db),
        listAllVariants(db),
        listLocations(db, storeId),
        getStockLevels(db, storeId),
        getLowStockProducts(db, storeId),
        listExpiringBatches(db, EXPIRY_WARNING_DAYS, storeId),
        getSettings(db),
      ]);
    setProducts(productsRows);
    setVariants(variantsRows);
    setLocations(locationsRows);
    setLevels(levelsRows);
    setLowStock(lowStockRows);
    setExpiring(expiringRows);
    setBusinessSettings(settings);
  }, [db, currentStoreId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const productName = (productId: number) => products.find((p) => p.id === productId)?.name ?? "—";

  const variantLabel = (variant: Variant) => {
    const product = products.find((p) => p.id === variant.productId);
    const attrs = variant.attributes && variant.attributes !== "{}" ? ` (${variant.attributes})` : "";
    return `${product?.name ?? "?"}${attrs}`;
  };

  const quantityFor = (vId: number, lId: number) =>
    levels.find((l) => l.variantId === vId && l.locationId === lId)?.quantity ?? 0;

  // Filtrage côté client : la table des niveaux de stock est bornée par la
  // taille du catalogue (variantes × emplacements), pas par le volume de
  // transactions — elle ne grossit pas avec les années, contrairement aux
  // journaux (voir JournalsPage). Un simple filter() suffit.
  const filteredVariants = useMemo(() => {
    const term = search.trim().toLowerCase();
    const locId = filterLocationId ? Number(filterLocationId) : null;
    return variants.filter((variant) => {
      if (term && !variantLabel(variant).toLowerCase().includes(term)) return false;
      if (locId && quantityFor(variant.id, locId) <= 0) return false;
      if (lowStockOnly) {
        const total = locations.reduce((sum, loc) => sum + quantityFor(variant.id, loc.id), 0);
        const product = products.find((p) => p.id === variant.productId);
        if (!product || total > product.lowStockThreshold) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants, search, filterLocationId, lowStockOnly, levels, locations, products]);

  const selectedProductTracksExpiry = useMemo(() => {
    const variant = variants.find((v) => v.id === Number(variantId));
    if (!variant) return false;
    return products.find((p) => p.id === variant.productId)?.trackExpiry ?? false;
  }, [variantId, variants, products]);

  const handleEntry = async () => {
    setEntryError(null);
    const vId = Number(variantId);
    const lId = Number(entryLocationId);
    const qty = Number(entryQuantity);

    if (!vId || !lId || !qty || qty <= 0) {
      setEntryError("Sélectionne un produit, un emplacement et une quantité positive.");
      return;
    }
    if (selectedProductTracksExpiry && !expiryDate) {
      setEntryError("Ce produit est périssable : indique une date de péremption.");
      return;
    }

    setEntrySaving(true);
    try {
      let batchId: number | undefined;
      if (selectedProductTracksExpiry) {
        const batch = await createBatch(db, {
          variantId: vId,
          locationId: lId,
          lotNumber: lotNumber || undefined,
          expiryDate,
          quantity: qty,
        });
        batchId = batch.id;
      }

      await recordMovement(db, {
        variantId: vId,
        locationId: lId,
        quantityDelta: qty,
        movementType: "adjustment",
        referenceType: "manual",
        batchId,
        userId: user?.id,
      });

      setVariantId("");
      setEntryLocationId("");
      setEntryQuantity("0");
      setLotNumber("");
      setExpiryDate("");
      await refresh();
    } catch (err) {
      setEntryError(err instanceof Error ? err.message : "Impossible d'enregistrer l'entrée de stock.");
    } finally {
      setEntrySaving(false);
    }
  };

  const handleTransfer = async () => {
    setTransferError(null);
    const vId = Number(transferVariantId);
    const from = Number(fromLocationId);
    const to = Number(toLocationId);
    const qty = Number(transferQuantity);

    if (!vId || !from || !to || from === to || !qty || qty <= 0) {
      setTransferError("Sélectionne un produit, deux emplacements différents et une quantité positive.");
      return;
    }
    const available = quantityFor(vId, from);
    if (qty > available) {
      setTransferError(`Stock insuffisant dans l'emplacement source (disponible : ${available}).`);
      return;
    }

    setTransferSaving(true);
    try {
      await transferStock(db, {
        variantId: vId,
        fromLocationId: from,
        toLocationId: to,
        quantity: qty,
        userId: user?.id,
      });
      setTransferVariantId("");
      setFromLocationId("");
      setToLocationId("");
      setTransferQuantity("0");
      await refresh();
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : "Impossible de transférer le stock.");
    } finally {
      setTransferSaving(false);
    }
  };

  const handleLoss = async () => {
    setLossError(null);
    const vId = Number(lossVariantId);
    const lId = Number(lossLocationId);
    const qty = Number(lossQuantity);

    if (!vId || !lId || !qty || qty <= 0) {
      setLossError("Sélectionne un produit, un emplacement et une quantité positive.");
      return;
    }
    const available = quantityFor(vId, lId);
    if (qty > available) {
      setLossError(`Stock insuffisant dans cet emplacement (disponible : ${available}).`);
      return;
    }

    setLossSaving(true);
    try {
      await recordMovement(db, {
        variantId: vId,
        locationId: lId,
        quantityDelta: -qty,
        movementType: "loss",
        referenceType: lossReason,
        userId: user?.id,
      });
      setLossVariantId("");
      setLossLocationId("");
      setLossQuantity("0");
      setLossReason(LOSS_REASONS[0]!.value);
      await refresh();
    } catch (err) {
      setLossError(err instanceof Error ? err.message : "Impossible d'enregistrer le retrait.");
    } finally {
      setLossSaving(false);
    }
  };

  const lowStockAlertPhone = businessSettings?.lowStockAlertPhone?.trim();

  const handleNotifyLowStock = () => {
    if (!lowStockAlertPhone) return;
    const MAX_LISTED = 15;
    const lines = lowStock
      .slice(0, MAX_LISTED)
      .map((entry) => `- ${entry.product.name} : ${entry.totalStock}/${entry.product.lowStockThreshold}`);
    if (lowStock.length > MAX_LISTED) lines.push(`... et ${lowStock.length - MAX_LISTED} autre(s).`);
    const message = `Alerte stock bas — ${lowStock.length} produit(s) à réapprovisionner chez ${businessSettings?.businessName ?? "nous"} :\n${lines.join("\n")}`;
    void openExternalUrl(buildWhatsAppLink(lowStockAlertPhone, businessSettings?.whatsappCountryCode, message));
  };

  return (
    <main style={pageStyle}>
      <h1>Stock</h1>

      {lowStock.length > 0 && (
        <div style={{ ...cardStyle, borderLeft: "4px solid #f87171" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <strong>Alertes stock bas</strong>
            {lowStockAlertPhone && (
              <button
                style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 13, whiteSpace: "nowrap" }}
                onClick={handleNotifyLowStock}
              >
                Notifier sur WhatsApp
              </button>
            )}
          </div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {lowStock.map((entry) => (
              <li key={entry.product.id}>
                {entry.product.name} — {entry.totalStock} en stock (seuil {entry.product.lowStockThreshold})
              </li>
            ))}
          </ul>
          {!lowStockAlertPhone && (
            <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
              Renseigne un numéro dans Paramètres → Téléphone à notifier (alertes stock bas) pour activer la
              notification WhatsApp.
            </p>
          )}
        </div>
      )}

      {expiring.length > 0 && (
        <div style={{ ...cardStyle, borderLeft: "4px solid #facc15" }}>
          <strong>Péremptions proches (≤ {EXPIRY_WARNING_DAYS} jours)</strong>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {expiring.map((e) => (
              <li key={e.batch.id}>
                {productName(e.variant.productId)} — lot {e.batch.lotNumber || "—"} — expire le{" "}
                {e.batch.expiryDate}
              </li>
            ))}
          </ul>
        </div>
      )}

      <FilterBar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Nom du produit..."
        onReset={() => {
          setSearch("");
          setFilterLocationId("");
          setLowStockOnly(false);
        }}
      >
        <label>
          Emplacement
          <select style={inputStyle} value={filterLocationId} onChange={(e) => setFilterLocationId(e.target.value)}>
            <option value="">Tous</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={(e) => setLowStockOnly(e.target.checked)}
          />
          Stock bas seulement
        </label>
      </FilterBar>

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Produit</th>
            {locations.map((loc) => (
              <th style={thStyle} key={loc.id}>
                {loc.name}
              </th>
            ))}
            <th style={thStyle}>Total</th>
          </tr>
        </thead>
        <tbody>
          {filteredVariants.map((variant) => {
            const total = locations.reduce((sum, loc) => sum + quantityFor(variant.id, loc.id), 0);
            const product = products.find((p) => p.id === variant.productId);
            const isLow = product ? total <= product.lowStockThreshold : false;
            return (
              <tr key={variant.id}>
                <td style={tdStyle}>{variantLabel(variant)}</td>
                {locations.map((loc) => (
                  <td style={tdStyle} key={loc.id}>
                    {quantityFor(variant.id, loc.id)}
                  </td>
                ))}
                <td style={tdStyle}>
                  <span style={badgeStyle(isLow ? "warning" : "ok")}>{total}</span>
                </td>
              </tr>
            );
          })}
          {filteredVariants.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={locations.length + 2}>
                Aucun produit pour cette sélection.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {canManage && (
        <>
          <div style={cardStyle}>
            <strong>Entrée de stock</strong>
            <label>
              Produit
              <SearchableSelect
                value={variantId}
                onChange={setVariantId}
                options={variants.map((v) => ({ value: String(v.id), label: variantLabel(v) }))}
                emptyLabel="— Choisir —"
                placeholder="Rechercher un produit..."
              />
            </label>
            <label>
              Emplacement
              <select
                style={inputStyle}
                value={entryLocationId}
                onChange={(e) => setEntryLocationId(e.target.value)}
              >
                <option value="">— Choisir —</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Quantité
              <input
                style={inputStyle}
                type="number"
                value={entryQuantity}
                onChange={(e) => setEntryQuantity(e.target.value)}
              />
            </label>

            {selectedProductTracksExpiry && (
              <>
                <label>
                  Numéro de lot (optionnel)
                  <input style={inputStyle} value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} />
                </label>
                <label>
                  Date de péremption
                  <input
                    style={inputStyle}
                    type="date"
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                  />
                </label>
              </>
            )}

            {entryError && <p style={{ color: "#f87171" }}>{entryError}</p>}

            <button style={primaryButtonStyle} onClick={handleEntry} disabled={entrySaving}>
              {entrySaving ? "Enregistrement..." : "Ajouter au stock"}
            </button>
          </div>

          <div style={cardStyle}>
            <strong>Transfert Réserve ↔ Surface de vente</strong>
            <label>
              Produit
              <SearchableSelect
                value={transferVariantId}
                onChange={setTransferVariantId}
                options={variants.map((v) => ({ value: String(v.id), label: variantLabel(v) }))}
                emptyLabel="— Choisir —"
                placeholder="Rechercher un produit..."
              />
            </label>
            <div style={{ display: "flex", gap: 16 }}>
              <label style={{ flex: 1 }}>
                Depuis
                <select
                  style={inputStyle}
                  value={fromLocationId}
                  onChange={(e) => setFromLocationId(e.target.value)}
                >
                  <option value="">— Choisir —</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ flex: 1 }}>
                Vers
                <select
                  style={inputStyle}
                  value={toLocationId}
                  onChange={(e) => setToLocationId(e.target.value)}
                >
                  <option value="">— Choisir —</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Quantité
              <input
                style={inputStyle}
                type="number"
                value={transferQuantity}
                onChange={(e) => setTransferQuantity(e.target.value)}
              />
            </label>

            {transferError && <p style={{ color: "#f87171" }}>{transferError}</p>}

            <button style={primaryButtonStyle} onClick={handleTransfer} disabled={transferSaving}>
              {transferSaving ? "Transfert..." : "Transférer"}
            </button>
          </div>

          <div style={{ ...cardStyle, borderLeft: "4px solid #f87171" }}>
            <strong>Retrait pour perte, péremption ou destruction</strong>
            <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
              Retire du stock un produit périmé, cassé, volé ou détruit — sans passer par une vente.
              Le mouvement reste tracé dans les Journaux avec son motif.
            </p>
            <label>
              Produit
              <SearchableSelect
                value={lossVariantId}
                onChange={setLossVariantId}
                options={variants.map((v) => ({ value: String(v.id), label: variantLabel(v) }))}
                emptyLabel="— Choisir —"
                placeholder="Rechercher un produit..."
              />
            </label>
            <label>
              Emplacement
              <select
                style={inputStyle}
                value={lossLocationId}
                onChange={(e) => setLossLocationId(e.target.value)}
              >
                <option value="">— Choisir —</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Motif
              <select style={inputStyle} value={lossReason} onChange={(e) => setLossReason(e.target.value)}>
                {LOSS_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Quantité
              <input
                style={inputStyle}
                type="number"
                value={lossQuantity}
                onChange={(e) => setLossQuantity(e.target.value)}
              />
            </label>

            {lossError && <p style={{ color: "#f87171" }}>{lossError}</p>}

            <button
              style={{ ...primaryButtonStyle, background: "#dc2626" }}
              onClick={handleLoss}
              disabled={lossSaving}
            >
              {lossSaving ? "Enregistrement..." : "Retirer du stock"}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
