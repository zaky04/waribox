import { hasPermission } from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useAuth } from "../auth/useAuth";

type Store = typeof schema.stores.$inferSelect;

interface StoreSwitcherProps {
  enabled: boolean;
  stores: Store[];
}

// N'affiche rien tant que le multi-boutique n'est pas activé dans les
// paramètres, ou s'il n'y a qu'une seule boutique active — évite d'exposer un
// sélecteur inutile aux installations mono-boutique (l'immense majorité).
// `enabled`/`stores` viennent de MainContent (App.tsx), qui les recharge à
// chaque changement d'onglet — pas de lecture locale ici, pour ne pas
// retomber dans l'état figé d'avant (le sélecteur ne se mettait à jour
// qu'au prochain verrouillage/déverrouillage de session).
export function StoreSwitcher({ enabled, stores }: StoreSwitcherProps) {
  const { user, currentStoreId, setCurrentStore } = useAuth();
  const canSwitch = hasPermission(user?.permissions ?? {}, "switch_store");
  const activeStores = stores.filter((s) => s.isActive);
  if (!enabled || !canSwitch || activeStores.length <= 1) return null;

  return (
    <select
      value={currentStoreId ?? ""}
      onChange={(e) => setCurrentStore(Number(e.target.value))}
      style={{
        // `background: transparent` casse la popup native du <select> : le
        // texte hérite de `color` (clair en thème sombre) mais la liste
        // d'options garde le fond blanc par défaut du système, ce qui rendait
        // les options illisibles en mode sombre. Un fond opaque explicite,
        // comme sur tous les autres <select> de l'app (voir inputStyle),
        // corrige ça.
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)",
        color: "var(--color-text)",
        borderRadius: 8,
        padding: "6px 12px",
        cursor: "pointer",
      }}
    >
      {activeStores.map((store) => (
        <option key={store.id} value={store.id}>
          {store.name}
        </option>
      ))}
    </select>
  );
}
