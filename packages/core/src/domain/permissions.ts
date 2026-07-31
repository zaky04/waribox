export const PERMISSIONS = [
  "view_margins",
  "manage_products",
  "manage_stock",
  "manage_sales",
  "manage_service_orders",
  "edit_service_orders",
  "manage_customers",
  "edit_customers",
  "manage_suppliers",
  "edit_suppliers",
  "manage_quotes",
  "edit_quotes",
  "manage_credits",
  "manage_debts",
  "manage_expenses",
  "edit_expenses",
  "view_reports",
  "view_accounting",
  "manage_settings",
  "manage_users",
  "view_audit_logs",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type PermissionSet = Partial<Record<Permission, boolean>>;

export function hasPermission(permissions: PermissionSet, permission: Permission): boolean {
  return permissions[permission] === true;
}

// Levée par les fonctions de service sensibles (garde de défense en
// profondeur) — l'UI n'affiche déjà pas ces actions au rôle concerné, mais
// rien n'empêchait jusqu'ici d'appeler la fonction directement (ex: console
// du navigateur) pour contourner cette restriction purement visuelle.
export class PermissionError extends Error {
  constructor(message = "Action non autorisée pour ce rôle.") {
    super(message);
    this.name = "PermissionError";
  }
}

export function requirePermission(permissions: PermissionSet, permission: Permission): void {
  if (!hasPermission(permissions, permission)) {
    throw new PermissionError();
  }
}

const ALL_PERMISSIONS: PermissionSet = Object.fromEntries(
  PERMISSIONS.map((permission) => [permission, true]),
);

export interface MergeMissingPermissionsResult {
  merged: PermissionSet;
  changed: boolean;
}

// Ajoute au rôle existant les clés de permission présentes dans `defaults`
// mais absentes de `existing` — jamais l'inverse. Permet à une installation
// déjà déployée de rattraper automatiquement les permissions ajoutées par une
// mise à jour, sans jamais retirer une permission déjà accordée.
export function mergeMissingPermissions(
  existing: PermissionSet,
  defaults: PermissionSet,
): MergeMissingPermissionsResult {
  const merged: PermissionSet = { ...existing };
  let changed = false;

  for (const key of Object.keys(defaults) as Permission[]) {
    if (!(key in merged)) {
      merged[key] = defaults[key];
      changed = true;
    }
  }

  return { merged, changed };
}

export type DefaultRoleKey = "admin" | "gerant" | "vendeur" | "caissier";

// Les journaux (view_audit_logs) restent une exclusivité Admin — même le
// Gérant n'y a pas accès par défaut.
export const DEFAULT_ROLES: Record<DefaultRoleKey, { name: string; permissions: PermissionSet }> = {
  admin: {
    name: "Admin",
    permissions: ALL_PERMISSIONS,
  },
  gerant: {
    name: "Gérant",
    permissions: {
      view_margins: true,
      manage_products: true,
      manage_stock: true,
      manage_sales: true,
      manage_service_orders: true,
      edit_service_orders: true,
      manage_customers: true,
      edit_customers: true,
      manage_suppliers: true,
      edit_suppliers: true,
      manage_quotes: true,
      edit_quotes: true,
      manage_credits: true,
      manage_debts: true,
      manage_expenses: true,
      edit_expenses: true,
      view_reports: true,
      view_accounting: true,
    },
  },
  vendeur: {
    name: "Vendeur",
    permissions: {
      manage_sales: true,
      manage_service_orders: true,
      manage_customers: true,
      manage_stock: true,
      manage_quotes: true,
    },
  },
  caissier: {
    name: "Caissier",
    permissions: {
      manage_sales: true,
      manage_service_orders: true,
      manage_quotes: true,
    },
  },
};
