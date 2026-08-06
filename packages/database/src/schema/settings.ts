import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const businessSettings = sqliteTable("business_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }), // singleton, always id = 1
  businessName: text("business_name"),
  sectorType: text("sector_type"), // 'boutique' | 'supermarche' | 'restaurant' | 'librairie' | ...
  saleInterfaceMode: text("sale_interface_mode").notNull().default("pos"), // 'pos' | 'form'
  currency: text("currency").notNull().default("XOF"),
  defaultTaxRate: real("default_tax_rate").notNull().default(0),
  // Interrupteur global — quand désactivé, aucune TVA n'est calculée ni
  // affichée nulle part (prix affichés = prix payés), quel que soit le taux
  // configuré ci-dessus. Les prix saisis (produits, lignes de vente) sont
  // toujours TTC — le taux sert à extraire la part de TVA pour l'affichage
  // sur les reçus/devis, pas à l'ajouter au prix.
  taxEnabled: integer("tax_enabled", { mode: "boolean" }).notNull().default(false),
  loyaltyPointsRatio: real("loyalty_points_ratio").notNull().default(0),
  // Paliers de fidélité (Bronze = palier de base, sans seuil) — un client
  // atteint Argent/Or quand son cumul à vie (lifetimeLoyaltyPoints) dépasse
  // ces seuils, et gagne alors ses points au taux ci-dessus multiplié par le
  // multiplicateur du palier (voir LoyaltyService.computeTier/earnPoints).
  loyaltyTierSilverThreshold: real("loyalty_tier_silver_threshold").notNull().default(5000),
  loyaltyTierGoldThreshold: real("loyalty_tier_gold_threshold").notNull().default(20000),
  loyaltyTierSilverMultiplier: real("loyalty_tier_silver_multiplier").notNull().default(1.25),
  loyaltyTierGoldMultiplier: real("loyalty_tier_gold_multiplier").notNull().default(1.5),
  backupFrequency: text("backup_frequency").notNull().default("weekly"),
  googleDriveClientId: text("google_drive_client_id"),
  logoDataUrl: text("logo_data_url"),
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  // Indicatif pays (ex: "225") utilisé pour compléter les numéros locaux des
  // clients lors de la génération d'un lien wa.me (voir lib/whatsapp.ts).
  whatsappCountryCode: text("whatsapp_country_code"),
  // Largeur du ticket en caractères (Font A) — 32 = 58mm, 48 = 80mm, ou une
  // valeur personnalisée pour du matériel non standard.
  receiptColumns: integer("receipt_columns").notNull().default(32),
  enableServiceOrders: integer("enable_service_orders", { mode: "boolean" }).notNull().default(false),
  printPromisedDateOnTicket: integer("print_promised_date_on_ticket", { mode: "boolean" })
    .notNull()
    .default(true),
  // Secret distinct des comptes utilisateurs — protège les actions de
  // maintenance (installation d'une mise à jour) indépendamment du mot de
  // passe Admin du client.
  maintenanceCodeHash: text("maintenance_code_hash"),
  // Verrouille automatiquement la session (retour à l'écran PIN) après ce
  // délai d'inactivité — 0 désactive la fonctionnalité.
  autoLockMinutes: integer("auto_lock_minutes").notNull().default(0),
  // Modules optionnels choisis à l'installation (écran ModuleSetupScreen),
  // modifiables ensuite dans Paramètres. Défaut true pour ne rien changer
  // aux installations déjà déployées lors d'une mise à jour — seule la toute
  // première ligne business_settings (vraie installation neuve) force
  // modulesConfigured à false pour déclencher l'assistant (voir SettingsService).
  enableSales: integer("enable_sales", { mode: "boolean" }).notNull().default(true),
  enableProducts: integer("enable_products", { mode: "boolean" }).notNull().default(true),
  enableStock: integer("enable_stock", { mode: "boolean" }).notNull().default(true),
  enableSuppliers: integer("enable_suppliers", { mode: "boolean" }).notNull().default(true),
  enablePurchases: integer("enable_purchases", { mode: "boolean" }).notNull().default(true),
  modulesConfigured: integer("modules_configured", { mode: "boolean" }).notNull().default(true),
  // Affiche/masque le sélecteur de boutique et la gestion des succursales —
  // la table stores et le storeId sur stockLocations/sales/cashSessions/
  // payments existent toujours en base, même désactivé (voir stores.ts).
  multiStoreEnabled: integer("multi_store_enabled", { mode: "boolean" }).notNull().default(false),
});
