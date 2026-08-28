import {
  addManualStockEntry,
  getLocationDisplayName,
  getLowStockProducts,
  getSettings,
  getStockLevels,
  hasPermission,
  listAllVariants,
  listExpiringBatches,
  listLocations,
  listProducts,
  recordStockLoss,
  transferStock,
  type ExpiringBatch,
  type LowStockEntry,
  type StockLevel,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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

export function StockPage() {
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const { t } = useTranslation();
  const canManage = hasPermission(user?.permissions ?? {}, "manage_stock");

  const LOSS_REASONS: { value: string; label: string }[] = [
    { value: "expiry", label: t("journals.lossReasons.expiry") },
    { value: "damage", label: t("journals.lossReasons.damage") },
    { value: "theft", label: t("journals.lossReasons.theft") },
    { value: "other", label: t("journals.lossReasons.other") },
  ];

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
      setEntryError(t("stock.errors.entryRequired"));
      return;
    }
    if (selectedProductTracksExpiry && !expiryDate) {
      setEntryError(t("stock.errors.entryExpiryRequired"));
      return;
    }

    setEntrySaving(true);
    try {
      await addManualStockEntry(
        db,
        {
          variantId: vId,
          locationId: lId,
          quantity: qty,
          lotNumber: lotNumber || undefined,
          expiryDate: selectedProductTracksExpiry ? expiryDate : undefined,
          userId: user?.id,
        },
        user?.permissions ?? {},
      );

      setVariantId("");
      setEntryLocationId("");
      setEntryQuantity("0");
      setLotNumber("");
      setExpiryDate("");
      await refresh();
    } catch (err) {
      setEntryError(err instanceof Error ? err.message : t("stock.errors.entryFailed"));
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
      setTransferError(t("stock.errors.transferRequired"));
      return;
    }
    const available = quantityFor(vId, from);
    if (qty > available) {
      setTransferError(t("stock.errors.transferInsufficient", { available }));
      return;
    }

    setTransferSaving(true);
    try {
      await transferStock(
        db,
        {
          variantId: vId,
          fromLocationId: from,
          toLocationId: to,
          quantity: qty,
          userId: user?.id,
        },
        user?.permissions ?? {},
      );
      setTransferVariantId("");
      setFromLocationId("");
      setToLocationId("");
      setTransferQuantity("0");
      await refresh();
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : t("stock.errors.transferFailed"));
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
      setLossError(t("stock.errors.lossRequired"));
      return;
    }
    const available = quantityFor(vId, lId);
    if (qty > available) {
      setLossError(t("stock.errors.lossInsufficient", { available }));
      return;
    }

    setLossSaving(true);
    try {
      await recordStockLoss(
        db,
        {
          variantId: vId,
          locationId: lId,
          quantity: qty,
          reason: lossReason,
          userId: user?.id,
        },
        user?.permissions ?? {},
      );
      setLossVariantId("");
      setLossLocationId("");
      setLossQuantity("0");
      setLossReason(LOSS_REASONS[0]!.value);
      await refresh();
    } catch (err) {
      setLossError(err instanceof Error ? err.message : t("stock.errors.lossFailed"));
    } finally {
      setLossSaving(false);
    }
  };

  const lowStockAlertPhone = businessSettings?.lowStockAlertPhone?.trim();

  const handleNotifyLowStock = () => {
    if (!lowStockAlertPhone) return;
    const MAX_LISTED = 15;
    const business = businessSettings?.businessName ?? t("whatsapp.defaultBusinessName");
    const lines = lowStock
      .slice(0, MAX_LISTED)
      .map((entry) =>
        t("whatsapp.lowStockLine", {
          name: entry.product.name,
          stock: entry.totalStock,
          threshold: entry.product.lowStockThreshold,
        }),
      );
    if (lowStock.length > MAX_LISTED) lines.push(t("whatsapp.moreItems", { count: lowStock.length - MAX_LISTED }));
    const message = t("whatsapp.lowStockAlert", { count: lowStock.length, business, lines: lines.join("\n") });
    void openExternalUrl(buildWhatsAppLink(lowStockAlertPhone, businessSettings?.whatsappCountryCode, message));
  };

  // Même numéro que l'alerte stock bas (business_settings.lowStockAlertPhone)
  // — un seul réglage "téléphone à notifier" pour les deux types d'alerte
  // stock, pas de champ dédié supplémentaire dans Paramètres.
  const handleNotifyExpiring = () => {
    if (!lowStockAlertPhone) return;
    const MAX_LISTED = 15;
    const business = businessSettings?.businessName ?? t("whatsapp.defaultBusinessName");
    const lines = expiring
      .slice(0, MAX_LISTED)
      .map((e) =>
        t("whatsapp.expiringLine", {
          name: productName(e.variant.productId),
          lot: e.batch.lotNumber || "—",
          date: e.batch.expiryDate,
        }),
      );
    if (expiring.length > MAX_LISTED) lines.push(t("whatsapp.moreItems", { count: expiring.length - MAX_LISTED }));
    const message = t("whatsapp.expiringAlert", {
      days: EXPIRY_WARNING_DAYS,
      count: expiring.length,
      business,
      lines: lines.join("\n"),
    });
    void openExternalUrl(buildWhatsAppLink(lowStockAlertPhone, businessSettings?.whatsappCountryCode, message));
  };

  return (
    <main style={pageStyle}>
      <h1>{t("stock.title")}</h1>

      {lowStock.length > 0 && (
        <div style={{ ...cardStyle, borderLeft: "4px solid var(--color-danger)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <strong>{t("stock.lowStockAlerts")}</strong>
            {lowStockAlertPhone && (
              <button
                style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 13, whiteSpace: "nowrap" }}
                onClick={handleNotifyLowStock}
              >
                {t("stock.notifyWhatsapp")}
              </button>
            )}
          </div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {lowStock.map((entry) => (
              <li key={entry.product.id}>
                {t("stock.lowStockLine", {
                  name: entry.product.name,
                  total: entry.totalStock,
                  threshold: entry.product.lowStockThreshold,
                })}
              </li>
            ))}
          </ul>
          {!lowStockAlertPhone && (
            <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("stock.noPhoneHint")}</p>
          )}
        </div>
      )}

      {expiring.length > 0 && (
        <div style={{ ...cardStyle, borderLeft: "4px solid var(--color-caution)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <strong>{t("stock.expiringSoon", { days: EXPIRY_WARNING_DAYS })}</strong>
            {lowStockAlertPhone && (
              <button
                style={{ ...primaryButtonStyle, padding: "6px 12px", fontSize: 13, whiteSpace: "nowrap" }}
                onClick={handleNotifyExpiring}
              >
                {t("stock.notifyWhatsapp")}
              </button>
            )}
          </div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {expiring.map((e) => (
              <li key={e.batch.id}>
                {t("stock.expiringLine", {
                  product: productName(e.variant.productId),
                  lot: e.batch.lotNumber || "—",
                  date: e.batch.expiryDate,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      <FilterBar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={t("stock.searchPlaceholder")}
        onReset={() => {
          setSearch("");
          setFilterLocationId("");
          setLowStockOnly(false);
        }}
      >
        <label>
          {t("stock.location")}
          <select style={inputStyle} value={filterLocationId} onChange={(e) => setFilterLocationId(e.target.value)}>
            <option value="">{t("stock.all")}</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {getLocationDisplayName(loc.name)}
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
          {t("stock.lowStockOnly")}
        </label>
      </FilterBar>

      <div className="table-scroll">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>{t("stock.product")}</th>
              {locations.map((loc) => (
                <th style={thStyle} key={loc.id}>
                  {getLocationDisplayName(loc.name)}
                </th>
              ))}
              <th style={thStyle}>{t("stock.total")}</th>
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
                  {t("stock.noProducts")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {canManage && (
        <>
          <div style={cardStyle}>
            <strong>{t("stock.entry.heading")}</strong>
            <label>
              {t("stock.product")}
              <SearchableSelect
                value={variantId}
                onChange={setVariantId}
                options={variants.map((v) => ({ value: String(v.id), label: variantLabel(v) }))}
                emptyLabel={t("stock.chooseOption")}
                placeholder={t("stock.searchProductPlaceholder")}
              />
            </label>
            <label>
              {t("stock.location")}
              <select
                style={inputStyle}
                value={entryLocationId}
                onChange={(e) => setEntryLocationId(e.target.value)}
              >
                <option value="">{t("stock.chooseOption")}</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {getLocationDisplayName(loc.name)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("stock.quantity")}
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
                  {t("stock.entry.lotNumber")}
                  <input style={inputStyle} value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} />
                </label>
                <label>
                  {t("stock.entry.expiryDate")}
                  <input
                    style={inputStyle}
                    type="date"
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                  />
                </label>
              </>
            )}

            {entryError && <p style={{ color: "var(--color-danger)" }}>{entryError}</p>}

            <button style={primaryButtonStyle} onClick={handleEntry} disabled={entrySaving}>
              {entrySaving ? t("stock.entry.saving") : t("stock.entry.submit")}
            </button>
          </div>

          <div style={cardStyle}>
            <strong>{t("stock.transfer.heading")}</strong>
            <label>
              {t("stock.product")}
              <SearchableSelect
                value={transferVariantId}
                onChange={setTransferVariantId}
                options={variants.map((v) => ({ value: String(v.id), label: variantLabel(v) }))}
                emptyLabel={t("stock.chooseOption")}
                placeholder={t("stock.searchProductPlaceholder")}
              />
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              <label style={{ flex: 1 }}>
                {t("stock.transfer.from")}
                <select
                  style={inputStyle}
                  value={fromLocationId}
                  onChange={(e) => setFromLocationId(e.target.value)}
                >
                  <option value="">{t("stock.chooseOption")}</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {getLocationDisplayName(loc.name)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ flex: 1 }}>
                {t("stock.transfer.to")}
                <select
                  style={inputStyle}
                  value={toLocationId}
                  onChange={(e) => setToLocationId(e.target.value)}
                >
                  <option value="">{t("stock.chooseOption")}</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {getLocationDisplayName(loc.name)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              {t("stock.quantity")}
              <input
                style={inputStyle}
                type="number"
                value={transferQuantity}
                onChange={(e) => setTransferQuantity(e.target.value)}
              />
            </label>

            {transferError && <p style={{ color: "var(--color-danger)" }}>{transferError}</p>}

            <button style={primaryButtonStyle} onClick={handleTransfer} disabled={transferSaving}>
              {transferSaving ? t("stock.transfer.transferring") : t("stock.transfer.submit")}
            </button>
          </div>

          <div style={{ ...cardStyle, borderLeft: "4px solid var(--color-danger)" }}>
            <strong>{t("stock.loss.heading")}</strong>
            <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("stock.loss.hint")}</p>
            <label>
              {t("stock.product")}
              <SearchableSelect
                value={lossVariantId}
                onChange={setLossVariantId}
                options={variants.map((v) => ({ value: String(v.id), label: variantLabel(v) }))}
                emptyLabel={t("stock.chooseOption")}
                placeholder={t("stock.searchProductPlaceholder")}
              />
            </label>
            <label>
              {t("stock.location")}
              <select
                style={inputStyle}
                value={lossLocationId}
                onChange={(e) => setLossLocationId(e.target.value)}
              >
                <option value="">{t("stock.chooseOption")}</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {getLocationDisplayName(loc.name)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("stock.loss.reason")}
              <select style={inputStyle} value={lossReason} onChange={(e) => setLossReason(e.target.value)}>
                {LOSS_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("stock.quantity")}
              <input
                style={inputStyle}
                type="number"
                value={lossQuantity}
                onChange={(e) => setLossQuantity(e.target.value)}
              />
            </label>

            {lossError && <p style={{ color: "var(--color-danger)" }}>{lossError}</p>}

            <button
              style={{ ...primaryButtonStyle, background: "#dc2626" }}
              onClick={handleLoss}
              disabled={lossSaving}
            >
              {lossSaving ? t("stock.loss.saving") : t("stock.loss.submit")}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
