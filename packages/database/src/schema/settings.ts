import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const businessSettings = sqliteTable("business_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }), // singleton, always id = 1
  businessName: text("business_name"),
  sectorType: text("sector_type"), // 'boutique' | 'supermarche' | 'restaurant' | 'librairie' | ...
  saleInterfaceMode: text("sale_interface_mode").notNull().default("pos"), // 'pos' | 'form'
  currency: text("currency").notNull().default("XOF"),
  defaultTaxRate: real("default_tax_rate").notNull().default(0),
  loyaltyPointsRatio: real("loyalty_points_ratio").notNull().default(0),
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
});
