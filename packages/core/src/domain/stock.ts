import { t } from "@gestion-boutique/i18n";

export type DefaultLocationKey = "reserve" | "surface_vente";

export const DEFAULT_LOCATIONS: Record<
  DefaultLocationKey,
  { name: string; type: "reserve" | "surface_vente" }
> = {
  reserve: { name: "Réserve", type: "reserve" },
  surface_vente: { name: "Surface de vente", type: "surface_vente" },
};

const LOCATION_NAME_TO_KEY: Record<string, DefaultLocationKey> = Object.fromEntries(
  (Object.keys(DEFAULT_LOCATIONS) as DefaultLocationKey[]).map((key) => [DEFAULT_LOCATIONS[key].name, key]),
);

// Même principe que getRoleDisplayName (permissions.ts) : `stock_locations.name`
// reste stocké en français en base (voir ensureLocationsForStore) — seul
// `type` ("reserve"/"surface_vente", éventuellement suffixé par boutique)
// sert aux lookups/comparaisons dans le code, jamais `name`. Traduire cette
// donnée à la source serait donc sans risque de casser une comparaison, mais
// on garde la même stratégie d'affichage que les rôles pour rester cohérent
// et ne pas avoir deux conventions différentes pour le même genre de donnée
// seedée.
export function getLocationDisplayName(storedName: string): string {
  const key = LOCATION_NAME_TO_KEY[storedName];
  return key ? t(`locations.${key}`) : storedName;
}
