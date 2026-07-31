import { updateSettings } from "@gestion-boutique/core";
import { useState } from "react";
import { useDatabase } from "../../app/DatabaseProvider";
import { authCardStyle, authPrimaryButtonStyle } from "./styles";
import { useAuth } from "./useAuth";

interface ModuleSetupScreenProps {
  onDone: () => void;
}

type ModuleKey =
  | "enableSales"
  | "enableProducts"
  | "enableStock"
  | "enableSuppliers"
  | "enablePurchases"
  | "enableServiceOrders";

const MODULES: { key: ModuleKey; label: string }[] = [
  { key: "enableSales", label: "Ventes au comptoir" },
  { key: "enableProducts", label: "Catalogue produits" },
  { key: "enableStock", label: "Gestion de stock" },
  { key: "enableSuppliers", label: "Fournisseurs" },
  { key: "enablePurchases", label: "Achats" },
  { key: "enableServiceOrders", label: "Tickets de service (dépôt/retrait différé — pressing, cordonnerie...)" },
];

// Écran affiché une seule fois, juste après la création du compte
// administrateur (voir AuthGate.tsx) — un pressing n'a par exemple aucun
// besoin des modules Ventes/Produits/Stock/Fournisseurs/Achats. Modifiable
// ensuite à tout moment dans Paramètres > Modules actifs.
export function ModuleSetupScreen({ onDone }: ModuleSetupScreenProps) {
  const db = useDatabase();
  const { user } = useAuth();
  const [selected, setSelected] = useState<Record<ModuleKey, boolean>>({
    enableSales: true,
    enableProducts: true,
    enableStock: true,
    enableSuppliers: true,
    enablePurchases: true,
    enableServiceOrders: false,
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await updateSettings(db, { ...selected, modulesConfigured: true }, user?.permissions ?? {});
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <main style={{ maxWidth: 480, margin: "60px auto", padding: 24 }}>
      <h1>Modules à activer</h1>
      <p style={{ color: "var(--color-text-muted)" }}>
        Choisis les fonctionnalités utiles à ton commerce — modifiable à tout moment ensuite dans
        Paramètres.
      </p>

      <div style={authCardStyle}>
        {MODULES.map((m) => (
          <label key={m.key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input
              type="checkbox"
              checked={selected[m.key]}
              onChange={(e) => setSelected((prev) => ({ ...prev, [m.key]: e.target.checked }))}
            />
            {m.label}
          </label>
        ))}

        <button style={authPrimaryButtonStyle} onClick={handleSubmit} disabled={saving}>
          {saving ? "Enregistrement..." : "Continuer"}
        </button>
      </div>
    </main>
  );
}
