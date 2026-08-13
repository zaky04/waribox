import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { logAction } from "./AuditService";
import { requirePermission, type PermissionSet } from "../domain/permissions";

// Une session est scopée par (utilisateur, boutique) — un même caissier peut
// avoir une session ouverte par boutique s'il opère sur plusieurs.
export async function getActiveSession(db: Database, userId: number, storeId: number) {
  return db
    .select()
    .from(schema.cashSessions)
    .where(
      and(
        eq(schema.cashSessions.userId, userId),
        eq(schema.cashSessions.storeId, storeId),
        isNull(schema.cashSessions.closedAt),
      ),
    )
    .get();
}

export interface OpenSessionInput {
  userId: number;
  storeId: number;
  openingAmount: number;
}

export async function openSession(
  db: Database,
  input: OpenSessionInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_sales");
  const existing = await getActiveSession(db, input.userId, input.storeId);
  if (existing) return existing;

  const session = await db
    .insert(schema.cashSessions)
    .values({ userId: input.userId, storeId: input.storeId, openingAmount: input.openingAmount })
    .returning()
    .get();

  await logAction(db, {
    userId: input.userId,
    action: "open_cash_session",
    entity: "cash_session",
    entityId: session.id,
    metadata: { openingAmount: input.openingAmount },
  });

  return session;
}

// Montant théoriquement présent dans le tiroir : le fond de caisse d'ouverture
// plus les encaissements espèces de la session (ventes moins remboursements),
// réglés par ce même caissier depuis l'ouverture. Ignore les paiements par
// carte/mobile money — seul le liquide passe physiquement par le tiroir.
export async function getExpectedCashAmount(
  db: Database,
  session: typeof schema.cashSessions.$inferSelect,
): Promise<number> {
  const conditions = [
    eq(schema.payments.method, "cash"),
    eq(schema.payments.receivedBy, session.userId),
    gte(schema.payments.createdAt, session.openedAt),
  ];
  if (session.storeId != null) conditions.push(eq(schema.payments.storeId, session.storeId));

  const cashPayments = await db
    .select()
    .from(schema.payments)
    .where(and(...conditions));

  let net = 0;
  for (const payment of cashPayments) {
    if (payment.referenceType === "sale") net += payment.amount;
    else if (payment.referenceType === "refund") net -= payment.amount;
  }

  return session.openingAmount + net;
}

export interface CloseSessionInput {
  sessionId: number;
  closingAmount: number;
  expectedAmount: number;
}

export async function closeSession(
  db: Database,
  input: CloseSessionInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_sales");
  const session = await db
    .update(schema.cashSessions)
    .set({
      closingAmount: input.closingAmount,
      expectedAmount: input.expectedAmount,
      closedAt: new Date().toISOString(),
    })
    .where(eq(schema.cashSessions.id, input.sessionId))
    .returning()
    .get();

  await logAction(db, {
    userId: session.userId,
    action: "close_cash_session",
    entity: "cash_session",
    entityId: session.id,
    metadata: {
      closingAmount: input.closingAmount,
      expectedAmount: input.expectedAmount,
      difference: input.closingAmount - input.expectedAmount,
    },
  });

  return session;
}

export interface CashSessionFilters {
  from?: string; // "YYYY-MM-DD"
  to?: string;
  storeId?: number;
}

// Historique des sessions de caisse pour le rapport de clôture (Rapports →
// Caisse) — inclut les sessions encore ouvertes (closedAt/closingAmount nuls)
// dans la plage, pas seulement les clôturées, pour ne pas donner l'illusion
// qu'une session en cours n'a jamais existé.
export async function listCashSessions(db: Database, filters: CashSessionFilters = {}) {
  const conditions = [];
  if (filters.from) conditions.push(gte(schema.cashSessions.openedAt, `${filters.from.slice(0, 10)} 00:00:00`));
  if (filters.to) conditions.push(lte(schema.cashSessions.openedAt, `${filters.to.slice(0, 10)} 23:59:59`));
  if (filters.storeId) conditions.push(eq(schema.cashSessions.storeId, filters.storeId));

  const query = db.select().from(schema.cashSessions).orderBy(desc(schema.cashSessions.id));
  return conditions.length > 0 ? query.where(and(...conditions)) : query;
}
