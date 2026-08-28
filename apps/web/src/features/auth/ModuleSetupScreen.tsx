import { updateSettings } from "@gestion-boutique/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
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

// Écran affiché une seule fois, juste après la création du compte
// administrateur (voir AuthGate.tsx) — un pressing n'a par exemple aucun
// besoin des modules Ventes/Produits/Stock/Fournisseurs/Achats. Modifiable
// ensuite à tout moment dans Paramètres > Modules actifs.
export function ModuleSetupScreen({ onDone }: ModuleSetupScreenProps) {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();

  const MODULES: { key: ModuleKey; label: string }[] = [
    { key: "enableSales", label: t("settings.modules.sales") },
    { key: "enableProducts", label: t("settings.modules.products") },
    { key: "enableStock", label: t("settings.modules.stock") },
    { key: "enableSuppliers", label: t("settings.modules.suppliers") },
    { key: "enablePurchases", label: t("settings.modules.purchases") },
    { key: "enableServiceOrders", label: t("settings.modules.serviceOrders") },
  ];

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
      <h1>{t("auth.moduleSetup.title")}</h1>
      <p style={{ color: "var(--color-text-muted)" }}>{t("auth.moduleSetup.hint")}</p>

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
          {saving ? t("auth.moduleSetup.saving") : t("auth.moduleSetup.continue")}
        </button>
      </div>
    </main>
  );
}
