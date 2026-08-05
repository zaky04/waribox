import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { requirePermission, type PermissionSet } from "../domain/permissions";

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
  return db
    .insert(schema.businessSettings)
    .values({ id: SETTINGS_ID, modulesConfigured: false })
    .returning()
    .get();
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
  maintenanceCodeHash?: string;
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
}

export async function updateSettings(db: Database, input: UpdateSettingsInput, actingPermissions: PermissionSet) {
  requirePermission(actingPermissions, "manage_settings");
  await getSettings(db);
  return db
    .update(schema.businessSettings)
    .set(input)
    .where(eq(schema.businessSettings.id, SETTINGS_ID))
    .returning()
    .get();
}
