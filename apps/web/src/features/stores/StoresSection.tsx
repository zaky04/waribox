import { createStore, listStores, updateStore } from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { inputStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { useAuth } from "../auth/useAuth";

type Store = typeof schema.stores.$inferSelect;

export function StoresSection() {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();

  const [stores, setStores] = useState<Store[]>([]);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setStores(await listStores(db));
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async () => {
    setError(null);
    if (!name.trim()) {
      setError(t("storesSection.errorNameRequired"));
      return;
    }
    setSaving(true);
    try {
      await createStore(
        db,
        { name: name.trim(), address: address.trim() || undefined, phone: phone.trim() || undefined },
        user?.permissions ?? {},
      );
      setName("");
      setAddress("");
      setPhone("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("storesSection.errorCreate"));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (store: Store) => {
    await updateStore(db, store.id, { isActive: !store.isActive }, user?.permissions ?? {});
    await refresh();
  };

  return (
    <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
      <strong style={{ fontSize: 14 }}>{t("storesSection.heading")}</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("storesSection.description")}</p>

      <div className="table-scroll">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>{t("storesSection.name")}</th>
              <th style={thStyle}>{t("storesSection.address")}</th>
              <th style={thStyle}>{t("storesSection.phone")}</th>
              <th style={thStyle}>{t("storesSection.status")}</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {stores.map((store) => (
              <tr key={store.id}>
                <td style={tdStyle}>{store.name}</td>
                <td style={tdStyle}>{store.address || "—"}</td>
                <td style={tdStyle}>{store.phone || "—"}</td>
                <td style={tdStyle}>{store.isActive ? t("storesSection.active") : t("storesSection.inactive")}</td>
                <td style={tdStyle}>
                  <button
                    onClick={() => handleToggleActive(store)}
                    style={{
                      background: "transparent",
                      border: "1px solid var(--color-border)",
                      color: "var(--color-text)",
                      borderRadius: 8,
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    {store.isActive ? t("storesSection.deactivate") : t("storesSection.activate")}
                  </button>
                </td>
              </tr>
            ))}
            {stores.length === 0 && (
              <tr>
                <td style={tdStyle} colSpan={5}>
                  {t("storesSection.none")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label>
          {t("storesSection.newName")}
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t("storesSection.newAddress")}
          <input style={inputStyle} value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label>
          {t("storesSection.newPhone")}
          <input style={inputStyle} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <button
          style={{ ...primaryButtonStyle, padding: "8px 14px", fontSize: 14 }}
          onClick={handleCreate}
          disabled={saving}
        >
          {saving ? t("storesSection.creating") : t("storesSection.add")}
        </button>
      </div>
      {error && <p style={{ color: "#f87171", fontSize: 13 }}>{error}</p>}
    </div>
  );
}
