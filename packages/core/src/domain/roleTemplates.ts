import type { Permission, PermissionSet } from "./permissions";

// Modèles de rôles prêts à l'emploi (Utilisateurs → Rôles → Nouveau rôle) : un point
// de départ que le propriétaire ajuste ensuite droit par droit. Aucun ne contient
// de droit d'approbation ni d'administration.
export type RoleTemplateId = "storekeeper" | "deputy_manager" | "senior_cashier" | "accountant" | "supervisor";

const list = (perms: Permission[]): PermissionSet => Object.fromEntries(perms.map((p) => [p, true]));

export const ROLE_TEMPLATES: Record<RoleTemplateId, PermissionSet> = {
  // Reçoit, range, compte : ne déclare pas de pertes, ne touche ni aux prix ni à la caisse.
  storekeeper: list(["manage_stock", "transfer_stock", "manage_inventory", "receive_purchases", "manage_products"]),
  // Comme un gérant, sans prix, dépenses supprimables, points ni exports.
  deputy_manager: list([
    "manage_sales", "open_close_cash", "sell_on_credit", "manage_refunds", "manage_quotes", "edit_quotes", "manage_service_orders", "edit_service_orders",
    "manage_products", "manage_stock", "transfer_stock", "record_stock_losses", "manage_inventory", "manage_customers", "edit_customers",
    "manage_suppliers", "manage_purchases", "receive_purchases", "manage_credits", "manage_expenses", "view_reports",
  ]),
  // Caissier confirmé : vend, ouvre/ferme la caisse, encaisse les créances, gère les clients.
  senior_cashier: list(["manage_sales", "open_close_cash", "sell_on_credit", "manage_quotes", "manage_service_orders", "manage_customers", "manage_credits"]),
  // Comptable : lit et exporte, saisit les dépenses, ne vend ni ne touche au stock.
  accountant: list(["view_accounting", "view_reports", "export_reports", "view_margins", "view_costs", "manage_expenses", "edit_expenses", "manage_debts"]),
  // Superviseur : lecture seule (rapports, marges, contrôles).
  supervisor: list(["view_reports", "view_margins", "view_costs", "view_controls"]),
};

export const ROLE_TEMPLATE_IDS = Object.keys(ROLE_TEMPLATES) as RoleTemplateId[];
