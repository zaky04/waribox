import { exportDatabaseFile, importDatabaseFile, schema, type Database } from "@gestion-boutique/database";
import { and, desc, eq } from "drizzle-orm";
import { requirePermission, type PermissionSet } from "../domain/permissions";

export type BackupDestination = "local" | "google_drive";
export type BackupStatus = "success" | "error";

export interface RecordBackupInput {
  destination: BackupDestination;
  fileRef?: string;
  status: BackupStatus;
}

export async function recordBackup(db: Database, input: RecordBackupInput) {
  return db
    .insert(schema.backups)
    .values({ destination: input.destination, fileRef: input.fileRef, status: input.status })
    .returning()
    .get();
}

export async function listBackups(db: Database) {
  return db.select().from(schema.backups).orderBy(desc(schema.backups.id));
}

export async function getLastSuccessfulBackup(db: Database, destination: BackupDestination) {
  return db
    .select()
    .from(schema.backups)
    .where(and(eq(schema.backups.destination, destination), eq(schema.backups.status, "success")))
    .orderBy(desc(schema.backups.id))
    .get();
}

const FREQUENCY_PRESETS: Record<string, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  off: 0,
};

// Compatible avec la valeur historique du schéma ("weekly") tout en
// permettant un délai personnalisé en jours saisi par l'utilisateur.
export function parseBackupFrequencyDays(value: string): number {
  const preset = FREQUENCY_PRESETS[value];
  if (preset !== undefined) return preset;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function isBackupDue(lastBackupAt: string | null, frequencyValue: string): boolean {
  const days = parseBackupFrequencyDays(frequencyValue);
  if (days <= 0) return false;
  if (!lastBackupAt) return true;
  const last = new Date(lastBackupAt.replace(" ", "T") + "Z").getTime();
  const dueAt = last + days * 24 * 60 * 60 * 1000;
  return Date.now() >= dueAt;
}

// "SQLite format 3" + un octet nul — entête standard de tout fichier SQLite.
// Construit via fromCharCode plutôt qu'un échappement \0 littéral dans la
// chaîne, pour éviter tout octet nul brut dans ce fichier source.
const SQLITE_HEADER = "SQLite format 3" + String.fromCharCode(0);

// Vérification volontairement légère (pas de réouverture complète du fichier
// dans une instance SQLite temporaire) : l'entête confirme que c'est bien un
// fichier SQLite, la recherche de "business_settings" (nom de table
// spécifique à cette app, jamais présent dans un fichier SQLite quelconque)
// confirme que c'est bien une sauvegarde WariBox — suffisant pour rejeter le
// cas réel le plus probable (mauvais fichier sélectionné par erreur) sans la
// complexité d'un second moteur SQLite juste pour valider.
export function validateBackupFile(bytes: Uint8Array): void {
  if (bytes.length < 16) {
    throw new Error("Ce fichier est trop petit pour être une sauvegarde valide.");
  }
  for (let i = 0; i < SQLITE_HEADER.length; i++) {
    if (bytes[i] !== SQLITE_HEADER.charCodeAt(i)) {
      throw new Error("Ce fichier n'est pas une base SQLite valide.");
    }
  }
  const text = new TextDecoder("iso-8859-1").decode(bytes);
  if (!text.includes("business_settings")) {
    throw new Error("Ce fichier ne semble pas être une sauvegarde WariBox.");
  }
}

export interface RestoreBackupResult {
  // État de la base juste avant l'écrasement — permet à l'appelant de
  // proposer un fichier de secours immédiat si la sauvegarde importée s'avère
  // finalement inadaptée après rechargement de la page.
  previousBytes: Uint8Array;
}

// Pas de paramètre `db` ni d'entrée dans le journal d'audit ici : l'action
// remplace le fichier SQLite en entier (donc le journal lui-même) — une
// entrée écrite avant serait perdue, une entrée écrite après appartiendrait à
// l'historique de la base importée, pas à celui de l'installation actuelle.
export async function restoreBackupFromFile(
  bytes: Uint8Array,
  actingPermissions: PermissionSet,
): Promise<RestoreBackupResult> {
  requirePermission(actingPermissions, "manage_settings");
  validateBackupFile(bytes);

  const { bytes: previousBytes } = await exportDatabaseFile();
  await importDatabaseFile(bytes);
  return { previousBytes };
}
