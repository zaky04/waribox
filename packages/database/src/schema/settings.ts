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
  // Numéro (gérant/propriétaire) à notifier par WhatsApp en cas de rupture de
  // stock — distinct de `phone` (coordonnées de l'entreprise affichées sur
  // les reçus) : celui-ci n'a de sens que comme destinataire d'alerte interne.
  lowStockAlertPhone: text("low_stock_alert_phone"),
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
  // Affiche/masque l'onglet Export SYSCOHADA dans Comptabilité — désactivé
  // par défaut (comme multiStoreEnabled), tous les commerces n'ayant pas
  // besoin d'un export comptable normé.
  enableSyscohada: integer("enable_syscohada", { mode: "boolean" }).notNull().default(false),
  // Numéros de compte SYSCOHADA modifiables — le référentiel est révisé de
  // temps à autre par l'OHADA, ces codes ne doivent donc jamais être figés
  // dans le code (voir SyscohadaService, qui les lit systématiquement depuis
  // ces colonnes plutôt que de les coder en dur). L'intitulé de chaque
  // compte-rôle reste fixe (défini dans SyscohadaService) : seul le NUMÉRO
  // de compte change d'une révision à l'autre, jamais son rôle comptable.
  syscohadaAccountClients: text("syscohada_account_clients").notNull().default("411"),
  syscohadaAccountFournisseurs: text("syscohada_account_fournisseurs").notNull().default("401"),
  syscohadaAccountTvaVentes: text("syscohada_account_tva_ventes").notNull().default("4431"),
  syscohadaAccountTvaServices: text("syscohada_account_tva_services").notNull().default("4432"),
  syscohadaAccountTvaAchats: text("syscohada_account_tva_achats").notNull().default("4452"),
  syscohadaAccountBanque: text("syscohada_account_banque").notNull().default("512"),
  syscohadaAccountCaisse: text("syscohada_account_caisse").notNull().default("571"),
  syscohadaAccountMobileMoney: text("syscohada_account_mobile_money").notNull().default("5715"),
  syscohadaAccountAchats: text("syscohada_account_achats").notNull().default("601"),
  syscohadaAccountVentes: text("syscohada_account_ventes").notNull().default("701"),
  syscohadaAccountServices: text("syscohada_account_services").notNull().default("706"),
  // Repli utilisé par SyscohadaService.resolveExpenseAccount quand une
  // catégorie de dépense (texte libre, voir expenses.ts) n'a pas de
  // correspondance dans syscohadaExpenseAccounts.
  syscohadaDefaultExpenseAccountCode: text("syscohada_default_expense_account_code").notNull().default("628"),
  syscohadaDefaultExpenseAccountLabel: text("syscohada_default_expense_account_label")
    .notNull()
    .default("Autres charges externes"),
  // Affiche/masque l'onglet Promotions et l'application automatique des
  // remises programmées aux ventes — désactivé par défaut (même convention
  // que multiStoreEnabled/enableSyscohada).
  enablePromotions: integer("enable_promotions", { mode: "boolean" }).notNull().default(false),
});
