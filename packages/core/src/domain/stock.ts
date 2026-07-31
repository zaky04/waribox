export type DefaultLocationKey = "reserve" | "surface_vente";

export const DEFAULT_LOCATIONS: Record<
  DefaultLocationKey,
  { name: string; type: "reserve" | "surface_vente" }
> = {
  reserve: { name: "Réserve", type: "reserve" },
  surface_vente: { name: "Surface de vente", type: "surface_vente" },
};
