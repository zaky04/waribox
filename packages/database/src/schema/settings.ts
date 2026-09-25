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
  // Même anti-brute-force que users.failedAttempts/lockedUntil (voir
  // AuthService) — le code de maintenance est un secret à part entière, il
  // mérite la même protection contre les essais répétés.
  maintenanceCodeFailedAttempts: integer("maintenance_code_failed_attempts").notNull().default(0),
  maintenanceCodeLockedUntil: text("maintenance_code_locked_until"),
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
  // Facture Normalisée Électronique (Côte d'Ivoire, DGI) — voir CLAUDE.md.
  // Coquille activable : reste false tant que le commerçant n'a pas obtenu
  // un accès DGI et saisi une vraie clé API. fneApiKey stockée en clair,
  // même convention que googleDriveClientId/maintenanceCodeHash ci-dessus.
  fneEnabled: integer("fne_enabled", { mode: "boolean" }).notNull().default(false),
  fneEnvironment: text("fne_environment").notNull().default("test"), // 'test' | 'prod'
  fneApiKey: text("fne_api_key"),
  // Fournie par la DGI à la validation du compte production — l'URL de test
  // est une constante en dur côté code (voir packages/core/src/fne/fneTypes.ts),
  // pas besoin de la stocker.
  fneApiBaseUrl: text("fne_api_base_url"),
  // Identifiants attribués par la DGI à l'inscription — sans rapport avec
  // les stores/stockLocations internes de WariBox.
  fneEstablishment: text("fne_establishment"),
  fnePointOfSale: text("fne_point_of_sale"),
  // Apparence (voir Paramètres → Apparence) — couleur d'accent et forme des
  // coins, indépendantes de `sectorType` ci-dessus (qui ne pilote plus que
  // l'icône/libellé de l'onglet "Produits", voir Nav.tsx). `null` = thème
  // par défaut (valeurs de :root dans index.css), une valeur explicite
  // écrase l'accent partout où l'app utilise déjà var(--color-accent)/
  // var(--gradient-accent)/etc. (voir apps/web/src/lib/appearance.ts).
  appearanceAccentColor: text("appearance_accent_color"),
  appearanceBackground: text("appearance_background"), // null (papier) | 'white' | 'grey' — thème clair seulement
  appearanceFont: text("appearance_font"), // null (Familjen Grotesk) | 'system' | 'serif'
  appearanceShape: text("appearance_shape"), // 'rounded' (défaut) | 'square'
  // --- Contrôles de gestion (voir CLAUDE.md, journal du 2026-09-25) ---
  // Seuils au-dessus desquels une action exige l'approbation d'un responsable
  // (code PIN d'un utilisateur ayant la permission approve_actions). NULL =
  // pas de contrôle ; 0 = toute action de ce type exige une approbation. Un
  // plafond propre à l'utilisateur (users.limit*) prime sur ces valeurs.
  approvalRefundThreshold: real("approval_refund_threshold"),
  approvalStockThreshold: real("approval_stock_threshold"), // valeur au coût d'une perte / entrée manuelle
  approvalCreditThreshold: real("approval_credit_threshold"),
  // Écart de caisse (|compté - attendu|) à partir duquel une clôture est
  // signalée. NULL = tout écart non nul est signalé.
  cashVarianceThreshold: real("cash_variance_threshold"),
  // Hausse de prix d'achat (en %, vs dernier coût connu) signalée à la saisie
  // d'un achat. 0 = désactivé.
  priceAlertPercent: real("price_alert_percent").notNull().default(10),
  // Achats en deux temps : la facture fournisseur est saisie, le stock n'entre
  // qu'à la réception contrôlée (quantités comptées).
  requirePurchaseReceipt: integer("require_purchase_receipt", { mode: "boolean" }).notNull().default(false),
  // Plafond de crédit par défaut d'un client (NULL/0 = illimité).
  defaultCreditLimit: real("default_credit_limit"),
});
