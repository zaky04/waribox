import { t } from "@gestion-boutique/i18n";

export const PERMISSIONS = [
  "view_margins",
  "manage_products",
  "manage_promotions",
  "manage_stock",
  "manage_sales",
  "manage_refunds",
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
  "switch_store",
  // Voir le tableau de bord "Contrôles" (anomalies par employé, fournisseurs).
  "view_controls",
  // Approuver, avec son code PIN, une action qui dépasse le plafond d'un autre
  // utilisateur (remboursement, perte de stock, crédit). Un utilisateur qui la
  // possède n'a lui-même besoin d'aucune approbation.
  "approve_actions",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type PermissionSet = Partial<Record<Permission, boolean>>;
// Droits particuliers d'un utilisateur : true accorde, false retire, absent = suit le rôle.
export type PermissionOverrides = Partial<Record<Permission, boolean>>;

// Regroupement pour l'écran de gestion des droits (chaque permission dans une
// seule catégorie).
export const PERMISSION_CATEGORIES: { key: string; permissions: Permission[] }[] = [
  { key: "sales", permissions: ["manage_sales", "manage_refunds", "manage_quotes", "edit_quotes", "manage_service_orders", "edit_service_orders", "manage_promotions"] },
  { key: "stock", permissions: ["manage_products", "manage_stock"] },
  { key: "people", permissions: ["manage_customers", "edit_customers", "manage_suppliers", "edit_suppliers"] },
  { key: "finance", permissions: ["manage_credits", "manage_debts", "manage_expenses", "edit_expenses", "view_margins", "view_accounting"] },
  { key: "reports", permissions: ["view_reports", "view_controls", "view_audit_logs"] },
  { key: "admin", permissions: ["manage_settings", "manage_users", "switch_store", "approve_actions"] },
];

// Permissions "de pouvoir" : on ne peut les accorder ou les retirer (à un rôle ou
// à un utilisateur) que si on les détient soi-même — sinon un Gérant à qui on
// aurait confié la gestion des utilisateurs pourrait s'attribuer le droit
// d'approuver ses propres opérations.
export const SENSITIVE_PERMISSIONS: Permission[] = [
  "manage_users",
  "manage_settings",
  "approve_actions",
  "view_audit_logs",
  "view_controls",
  "switch_store",
];

export function parseOverrides(raw: string | null | undefined): PermissionOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: PermissionOverrides = {};
    for (const key of PERMISSIONS) if (typeof parsed[key] === "boolean") out[key] = parsed[key] as boolean;
    return out;
  } catch {
    return {};
  }
}

// Droits effectifs = ceux du rôle, puis les droits particuliers par-dessus.
export function applyOverrides(base: PermissionSet, overrides: PermissionOverrides): PermissionSet {
  const out: PermissionSet = { ...base };
  for (const key of PERMISSIONS) if (overrides[key] !== undefined) out[key] = overrides[key];
  return out;
}

// Lève si le changement entre deux jeux de droits effectifs touche une
// permission sensible que l'auteur du changement ne détient pas.
export function assertCanChangePermissions(acting: PermissionSet, before: PermissionSet, after: PermissionSet): void {
  for (const key of SENSITIVE_PERMISSIONS) {
    if ((before[key] === true) !== (after[key] === true) && acting[key] !== true) {
      throw new PermissionError(t("coreErrors.roles.sensitiveDenied"));
    }
  }
}

export function hasPermission(permissions: PermissionSet, permission: Permission): boolean {
  return permissions[permission] === true;
}

// Levée par les fonctions de service sensibles (garde de défense en
// profondeur) — l'UI n'affiche déjà pas ces actions au rôle concerné, mais
// rien n'empêchait jusqu'ici d'appeler la fonction directement (ex: console
// du navigateur) pour contourner cette restriction purement visuelle.
export class PermissionError extends Error {
  constructor(message = t("coreErrors.auth.permissionDenied")) {
    super(message);
    this.name = "PermissionError";
  }
}

// Pour une primitive partagée par deux flux distincts qui ont chacun leur
// propre permission naturelle (ex: recordCreditRepayment, invoquée à la fois
// depuis Créances et depuis le suivi des tickets de service) — une seule des
// deux permissions suffit, plutôt que d'exiger les deux ou de dupliquer la
// fonction pour chaque appelant.
export function requireAnyPermission(permissions: PermissionSet, allowed: Permission[]): void {
  if (!allowed.some((permission) => hasPermission(permissions, permission))) {
    throw new PermissionError();
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

export type DefaultRoleKey = "admin" | "proprietaire" | "gerant" | "vendeur" | "caissier";

// Les journaux (view_audit_logs) restent une exclusivité Admin — même le
// Propriétaire n'y a pas accès par défaut (piste d'audit technique, pas une
// donnée de gestion). Le Propriétaire a en revanche toutes les autres
// permissions, y compris switch_store (accès à toutes les boutiques) —
// contrairement à Gérant/Vendeur/Caissier, qui restent cantonnés à la
// boutique qui leur est assignée (voir users.storeId).
const PROPRIETAIRE_PERMISSIONS: PermissionSet = Object.fromEntries(
  PERMISSIONS.filter((p) => p !== "view_audit_logs").map((permission) => [permission, true]),
);

export const DEFAULT_ROLES: Record<DefaultRoleKey, { name: string; permissions: PermissionSet }> = {
  admin: {
    name: "Admin",
    permissions: ALL_PERMISSIONS,
  },
  proprietaire: {
    name: "Propriétaire",
    permissions: PROPRIETAIRE_PERMISSIONS,
  },
  gerant: {
    name: "Gérant",
    permissions: {
      view_margins: true,
      manage_products: true,
      manage_promotions: true,
      manage_stock: true,
      manage_sales: true,
      manage_refunds: true,
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

const ROLE_NAME_TO_KEY: Record<string, DefaultRoleKey> = Object.fromEntries(
  (Object.keys(DEFAULT_ROLES) as DefaultRoleKey[]).map((key) => [DEFAULT_ROLES[key].name, key]),
);

// `roles.name` reste stocké en français en base (voir ensureDefaultRoles) et
// sert à des comparaisons d'égalité ailleurs (UsersPage.tsx) — donc jamais
// traduit à la source. Cette fonction ne traduit que l'affichage, à l'appel,
// pour les 5 rôles par défaut ; un rôle personnalisé (nom non reconnu) est
// affiché tel quel, son nom étant une donnée saisie par l'utilisateur, pas du
// texte d'interface.
export function getRoleDisplayName(storedName: string): string {
  const key = ROLE_NAME_TO_KEY[storedName];
  return key ? t(`roles.${key}`) : storedName;
}
