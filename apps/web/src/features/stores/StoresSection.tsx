import { createStore, listStores, updateStore } from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useDatabase } from "../../app/DatabaseProvider";
import { inputStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { useAuth } from "../auth/useAuth";

type Store = typeof schema.stores.$inferSelect;

export function StoresSection() {
  const db = useDatabase();
  const { user } = useAuth();

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
      setError("Le nom de la boutique est requis.");
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
      setError(err instanceof Error ? err.message : "Impossible de créer la boutique.");
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
      <strong style={{ fontSize: 14 }}>Boutiques</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
        Chaque boutique a son propre stock (Réserve/Surface de vente) et ses propres ventes — les
        produits, clients et fournisseurs restent partagés entre toutes les boutiques.
      </p>

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Nom</th>
            <th style={thStyle}>Adresse</th>
            <th style={thStyle}>Téléphone</th>
            <th style={thStyle}>Statut</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {stores.map((store) => (
            <tr key={store.id}>
              <td style={tdStyle}>{store.name}</td>
              <td style={tdStyle}>{store.address || "—"}</td>
              <td style={tdStyle}>{store.phone || "—"}</td>
              <td style={tdStyle}>{store.isActive ? "Active" : "Désactivée"}</td>
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
                  {store.isActive ? "Désactiver" : "Activer"}
                </button>
              </td>
            </tr>
          ))}
          {stores.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={5}>
                Aucune boutique pour le moment.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 12, marginTop: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label>
          Nom de la nouvelle boutique
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Adresse (optionnel)
          <input style={inputStyle} value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label>
          Téléphone (optionnel)
          <input style={inputStyle} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <button
          style={{ ...primaryButtonStyle, padding: "8px 14px", fontSize: 14 }}
          onClick={handleCreate}
          disabled={saving}
        >
          {saving ? "Création..." : "Ajouter une boutique"}
        </button>
      </div>
      {error && <p style={{ color: "#f87171", fontSize: 13 }}>{error}</p>}
    </div>
  );
}
