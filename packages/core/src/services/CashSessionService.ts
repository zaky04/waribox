import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { and, eq, isNull } from "drizzle-orm";
import { logAction } from "./AuditService";

export async function getActiveSession(db: Database, userId: number) {
  return db
    .select()
    .from(schema.cashSessions)
    .where(and(eq(schema.cashSessions.userId, userId), isNull(schema.cashSessions.closedAt)))
    .get();
}

export interface OpenSessionInput {
  userId: number;
  openingAmount: number;
}

export async function openSession(db: Database, input: OpenSessionInput) {
  const existing = await getActiveSession(db, input.userId);
  if (existing) return existing;

  const session = await db
    .insert(schema.cashSessions)
    .values({ userId: input.userId, openingAmount: input.openingAmount })
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
