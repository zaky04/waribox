import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { and, eq, gte, isNull } from "drizzle-orm";
import { logAction } from "./AuditService";

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

export async function openSession(db: Database, input: OpenSessionInput) {
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

export async function closeSession(db: Database, input: CloseSessionInput) {
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
