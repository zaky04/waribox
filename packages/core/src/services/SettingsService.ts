import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { t } from "@gestion-boutique/i18n";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { checkMaintenanceCode } from "./maintenanceCodeCheck";

const SETTINGS_ID = 1;

// Ligne singleton (id=1) — le bootstrap SQL crée seulement la table, pas la
// ligne, donc on l'insère à la demande au premier accès (pattern idempotent
// identique à StockService.ensureDefaultLocations).
export async function getSettings(db: Database) {
  const existing = await db
    .select()
    .from(schema.businessSettings)
    .where(eq(schema.businessSettings.id, SETTINGS_ID))
    .get();
  if (existing) return existing;

  // modulesConfigured: false uniquement ici — c'est ce qui distingue une
  // installation neuve (assistant de choix des modules affiché une fois,
  // voir ModuleSetupScreen/AuthGate) d'une base déjà en service qui se met à
  // jour (la colonne, ajoutée par MIGRATION_SQL, vaut alors true par défaut
  // pour ne rien changer à l'existant).
  // onConflictDoNothing : deux lectures simultanées au tout premier lancement
  // (ex. écran de connexion + reste de l'app) créaient chacune la ligne et la
  // seconde échouait sur la clé primaire.
  await db
    .insert(schema.businessSettings)
    .values({ id: SETTINGS_ID, modulesConfigured: false })
    .onConflictDoNothing()
    .run();
  const created = await db
    .select()
    .from(schema.businessSettings)
    .where(eq(schema.businessSettings.id, SETTINGS_ID))
    .get();
  if (!created) throw new Error("business_settings introuvable");
  return created;
}

export interface UpdateSettingsInput {
  businessName?: string;
  sectorType?: string;
  saleInterfaceMode?: string;
  currency?: string;
  defaultTaxRate?: number;
  taxEnabled?: boolean;
  loyaltyPointsRatio?: number;
  backupFrequency?: string;
  googleDriveClientId?: string;
  logoDataUrl?: string | null;
  address?: string;
  phone?: string;
  email?: string;
  whatsappCountryCode?: string;
  receiptColumns?: number;
  enableServiceOrders?: boolean;
  printPromisedDateOnTicket?: boolean;
  autoLockMinutes?: number;
  enableSales?: boolean;
  enableProducts?: boolean;
  enableStock?: boolean;
  enableSuppliers?: boolean;
  enablePurchases?: boolean;
  modulesConfigured?: boolean;
  multiStoreEnabled?: boolean;
  loyaltyTierSilverThreshold?: number;
  loyaltyTierGoldThreshold?: number;
  loyaltyTierSilverMultiplier?: number;
  loyaltyTierGoldMultiplier?: number;
  enableSyscohada?: boolean;
  syscohadaAccountClients?: string;
  syscohadaAccountFournisseurs?: string;
  syscohadaAccountTvaVentes?: string;
  syscohadaAccountTvaServices?: string;
  syscohadaAccountTvaAchats?: string;
  syscohadaAccountBanque?: string;
  syscohadaAccountCaisse?: string;
  syscohadaAccountMobileMoney?: string;
  syscohadaAccountAchats?: string;
  syscohadaAccountVentes?: string;
  syscohadaAccountServices?: string;
  syscohadaDefaultExpenseAccountCode?: string;
  syscohadaDefaultExpenseAccountLabel?: string;
  lowStockAlertPhone?: string;
  enablePromotions?: boolean;
  fneEnabled?: boolean;
  fneEnvironment?: string;
  fneApiKey?: string;
  fneApiBaseUrl?: string;
  fneEstablishment?: string;
  fnePointOfSale?: string;
  // `null` réinitialise explicitement au thème par défaut (même convention
  // que `logoDataUrl` ci-dessus) — `undefined` laisse le champ inchangé.
  appearanceAccentColor?: string | null;
  appearanceShape?: string | null;
  appearanceBackground?: string | null;
  appearanceFont?: string | null;
  // Contrôles de gestion (voir schema/settings.ts) — null désactive le contrôle.
  approvalRefundThreshold?: number | null;
  approvalStockThreshold?: number | null;
  approvalCreditThreshold?: number | null;
  cashVarianceThreshold?: number | null;
  priceAlertPercent?: number;
  requirePurchaseReceipt?: boolean;
  defaultCreditLimit?: number | null;
  // Preuve (code de maintenance) exigée pour modifier les réglages avancés
  // ci-dessous quand un code est défini. Jamais enregistrée.
  advancedCode?: string;
}

// Réglages "avancés" (Paramètres → Configuration avancée) : ce que le logiciel
// permet, donc ce que le vendeur active selon ce que le client a acheté.
export const ADVANCED_SETTING_KEYS = [
  "enableSales",
  "enableProducts",
  "enableStock",
  "enableSuppliers",
  "enablePurchases",
  "enableServiceOrders",
  "printPromisedDateOnTicket",
  "multiStoreEnabled",
] as const;

// Colonnes qu'aucun appel public ne doit pouvoir écrire (elles ont leur
// propre chemin : setMaintenanceCode / checkMaintenanceCode).
const NEVER_WRITABLE_KEYS = ["id", "maintenanceCodeHash", "maintenanceCodeFailedAttempts", "maintenanceCodeLockedUntil"];

// Champs avancés que `input` change réellement par rapport à `current`
// (une valeur identique n'est pas un changement — la page renvoie tous ses
// champs à chaque enregistrement).
export function changedAdvancedSettings(
  current: Record<string, unknown>,
  input: Record<string, unknown>,
): string[] {
  return ADVANCED_SETTING_KEYS.filter((key) => input[key] !== undefined && input[key] !== current[key]);
}

export async function updateSettings(db: Database, input: UpdateSettingsInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_settings");
  const current = await getSettings(db);

  const { advancedCode, ...values } = input;
  for (const key of NEVER_WRITABLE_KEYS) delete (values as Record<string, unknown>)[key];

  // Défense en profondeur (l'écran est déjà verrouillé côté UI) : sans ce
  // contrôle, un appel direct depuis la console contournait le code. Pas de
  // contrôle tant qu'aucun code n'est défini, ni pendant l'assistant de
  // premier démarrage (modulesConfigured = false).
  if (current.maintenanceCodeHash && current.modulesConfigured) {
    const changed = changedAdvancedSettings(current as Record<string, unknown>, values as Record<string, unknown>);
    if (changed.length > 0) {
      if (!advancedCode) throw new Error(t("coreErrors.settings.advancedCodeRequired"));
      if (!(await checkMaintenanceCode(db, advancedCode))) {
        throw new Error(t("coreErrors.settings.advancedCodeWrong"));
      }
    }
  }

  return db
    .update(schema.businessSettings)
    .set(values)
    .where(eq(schema.businessSettings.id, SETTINGS_ID))
    .returning()
    .get();
}
