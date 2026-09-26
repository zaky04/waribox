import { createServiceTariff, listServiceTariffs, updateServiceTariff } from "@gestion-boutique/core";
import type { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { formatAmount } from "../../lib/format";
import { useAuth } from "../auth/useAuth";

type Tariff = typeof schema.serviceTariffs.$inferSelect;

// Tarifs de services — FACULTATIF (voir ServiceTariffsService) : le propriétaire
// enregistre ses services courants pour que le prix soit contrôlé au comptoir ;
// sans tarif, la saisie des tickets reste manuelle.
export function ServiceTariffsSection() {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [tariffs, setTariffs] = useState<Tariff[]>([]);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setTariffs(await listServiceTariffs(db));
  }, [db]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const perms = user?.permissions ?? {};

  const add = async () => {
    setError(null);
    try {
      await createServiceTariff(db, { name, price: Number(price), userId: user?.id }, perms);
      setName("");
      setPrice("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggle = async (tariff: Tariff) => {
    setError(null);
    try {
      await updateServiceTariff(db, tariff.id, { isActive: !tariff.isActive }, user?.id, perms);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const changePrice = async (tariff: Tariff, value: string) => {
    setError(null);
    try {
      await updateServiceTariff(db, tariff.id, { price: Number(value) }, user?.id, perms);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={cardStyle}>
      <strong>{t("serviceTariffs.title")}</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("serviceTariffs.hint")}</p>
      {tariffs.length === 0 ? (
        <p style={{ margin: 0, color: "var(--color-text-muted)" }}>{t("serviceTariffs.none")}</p>
      ) : (
        <div className="table-scroll">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t("serviceTariffs.name")}</th>
                <th style={thStyle}>{t("serviceTariffs.price")}</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {tariffs.map((tf) => (
                <tr key={tf.id} style={{ opacity: tf.isActive ? 1 : 0.55 }}>
                  <td style={tdStyle}>
                    {tf.name} {!tf.isActive && <em>({t("serviceTariffs.inactive")})</em>}
                  </td>
                  <td style={tdStyle}>
                    <input
                      key={`${tf.id}-${tf.price}`}
                      style={{ ...inputStyle, width: 110, marginTop: 0 }}
                      type="number"
                      step="any"
                      min={0}
                      defaultValue={tf.price}
                      onBlur={(e) => {
                        if (Number(e.target.value) !== tf.price) void changePrice(tf, e.target.value);
                      }}
                      aria-label={`${tf.name} — ${formatAmount(tf.price)}`}
                    />
                  </td>
                  <td style={tdStyle}>
                    <button
                      style={{ ...primaryButtonStyle, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)", padding: "6px 12px" }}
                      onClick={() => toggle(tf)}
                    >
                      {tf.isActive ? t("serviceTariffs.disable") : t("serviceTariffs.enable")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
        <label style={{ flex: "1 1 200px" }}>
          {t("serviceTariffs.name")}
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ width: 130 }}>
          {t("serviceTariffs.price")}
          <input style={inputStyle} type="number" step="any" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <button style={primaryButtonStyle} onClick={add} disabled={!name.trim() || price === ""}>
          {t("serviceTariffs.add")}
        </button>
      </div>
      {error && <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{error}</p>}
    </div>
  );
}
