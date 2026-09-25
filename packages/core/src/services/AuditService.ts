import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { and, asc, desc, eq, gte, isNotNull, like, lte, or } from "drizzle-orm";

export interface LogActionInput {
  userId?: number | null;
  action: string;
  entity: string;
  entityId?: number | null;
  metadata?: Record<string, unknown>;
}

const GENESIS = "GENESIS";

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface AuditHashFields {
  userId: number | null;
  action: string;
  entity: string;
  entityId: number | null;
  metadata: string | null;
  createdAt: string;
}

// Contenu canonique haché : le hash précédent + tous les champs de la ligne.
export function computeAuditHash(prevHash: string, f: AuditHashFields): Promise<string> {
  return sha256Hex(JSON.stringify([prevHash, f.userId, f.action, f.entity, f.entityId, f.metadata, f.createdAt]));
}

// Les écritures du journal sont sérialisées : deux appels simultanés liraient le
// même "dernier hash" et fourcheraient la chaîne.
let auditQueue: Promise<unknown> = Promise.resolve();

// Le grand livre des actions clés (créations, mouvements manuels, ventes,
// sessions de caisse...). Réservé à l'Admin côté UI (permission
// view_audit_logs) — jamais affiché aux autres rôles. Chaque ligne est chaînée
// à la précédente par un hash SHA-256 : supprimer ou modifier une ligne
// casse la chaîne, détectable par verifyAuditChain.
export function logAction(db: Database, input: LogActionInput): Promise<void> {
  const run = auditQueue.then(() => writeAuditRow(db, input));
  auditQueue = run.catch(() => undefined);
  return run;
}

async function writeAuditRow(db: Database, input: LogActionInput): Promise<void> {
  const last = await db
    .select({ hash: schema.auditLog.hash })
    .from(schema.auditLog)
    .where(isNotNull(schema.auditLog.hash))
    .orderBy(desc(schema.auditLog.id))
    .limit(1)
    .get();
  const prevHash = last?.hash ?? GENESIS;
  // Même format que CURRENT_TIMESTAMP de SQLite (UTC), fixé ici pour être haché.
  const createdAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const fields: AuditHashFields = {
    userId: input.userId ?? null,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt,
  };
  const hash = await computeAuditHash(prevHash, fields);
  await db.insert(schema.auditLog).values({ ...fields, prevHash, hash });
}

export interface AuditChainRow extends AuditHashFields {
  id: number;
  prevHash: string | null;
  hash: string | null;
}

export interface AuditChainResult {
  ok: boolean;
  checked: number;
  legacyRows: number;
  headHash: string | null;
  brokenAtId?: number;
  reason?: "prev_mismatch" | "hash_mismatch" | "unhashed_after_chain";
}

// Vérifie la chaîne sur des lignes triées par id croissant (fonction pure,
// testable sans base). Les lignes antérieures à la fonctionnalité (hash NULL)
// sont ignorées tant qu'aucune ligne chaînée n'a été vue ; ensuite, une ligne
// sans hash est une anomalie (insertion hors application).
export async function verifyAuditRows(rows: AuditChainRow[]): Promise<AuditChainResult> {
  let expectedPrev = GENESIS;
  let checked = 0;
  let legacyRows = 0;
  let chainStarted = false;
  for (const row of rows) {
    if (row.hash == null) {
      if (chainStarted) return { ok: false, checked, legacyRows, headHash: null, brokenAtId: row.id, reason: "unhashed_after_chain" };
      legacyRows++;
      continue;
    }
    chainStarted = true;
    if (row.prevHash !== expectedPrev) {
      return { ok: false, checked, legacyRows, headHash: null, brokenAtId: row.id, reason: "prev_mismatch" };
    }
    const recomputed = await computeAuditHash(row.prevHash, row);
    if (recomputed !== row.hash) {
      return { ok: false, checked, legacyRows, headHash: null, brokenAtId: row.id, reason: "hash_mismatch" };
    }
    expectedPrev = row.hash;
    checked++;
  }
  return { ok: true, checked, legacyRows, headHash: chainStarted ? expectedPrev : null };
}

export async function verifyAuditChain(db: Database): Promise<AuditChainResult> {
  const rows = await db.select().from(schema.auditLog).orderBy(asc(schema.auditLog.id));
  return verifyAuditRows(rows);
}

export interface AuditLogFilters {
  from?: string; // "YYYY-MM-DD"
  to?: string;
  userId?: number;
  action?: string;
  search?: string; // LIKE sur action + entity + metadata
}

export async function listAuditLog(db: Database, filters: AuditLogFilters = {}) {
  const conditions = [];
  if (filters.from) conditions.push(gte(schema.auditLog.createdAt, `${filters.from.slice(0, 10)} 00:00:00`));
  if (filters.to) conditions.push(lte(schema.auditLog.createdAt, `${filters.to.slice(0, 10)} 23:59:59`));
  if (filters.userId) conditions.push(eq(schema.auditLog.userId, filters.userId));
  if (filters.action) conditions.push(eq(schema.auditLog.action, filters.action));
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    conditions.push(
      or(
        like(schema.auditLog.action, pattern),
        like(schema.auditLog.entity, pattern),
        like(schema.auditLog.metadata, pattern),
      ),
    );
  }

  const query = db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.id));
  return conditions.length > 0 ? query.where(and(...conditions)) : query;
}
