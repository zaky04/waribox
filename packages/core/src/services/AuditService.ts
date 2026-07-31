import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { and, desc, eq, gte, like, lte, or } from "drizzle-orm";

export interface LogActionInput {
  userId?: number | null;
  action: string;
  entity: string;
  entityId?: number | null;
  metadata?: Record<string, unknown>;
}

// Le grand livre des actions clés (créations, mouvements manuels, ventes,
// sessions de caisse...). Réservé à l'Admin côté UI (permission
// view_audit_logs) — jamais affiché aux autres rôles.
export async function logAction(db: Database, input: LogActionInput): Promise<void> {
  await db.insert(schema.auditLog).values({
    userId: input.userId ?? null,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  });
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
