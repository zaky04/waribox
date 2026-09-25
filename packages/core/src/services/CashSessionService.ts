import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { t } from "@gestion-boutique/i18n";
import { roundMoney } from "../domain/money";
import { getSettings } from "./SettingsService";
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
// plus les encaissements espèces de la session (ventes et tickets de service, moins remboursements),
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

  // Règlements de créances clients encaissés par ce caissier depuis l'ouverture
  // (sans mode de paiement renseigné = espèces, comme au comptoir).
  const repayments = await db
    .select()
    .from(schema.creditRepayments)
    .where(and(eq(schema.creditRepayments.receivedBy, session.userId), gte(schema.creditRepayments.paidAt, session.openedAt)));
  const cashRepayments = repayments.filter(
    (r) => (r.method == null || r.method === "cash") && (session.storeId == null || r.storeId == null || r.storeId === session.storeId),
  );

  let net = cashRepayments.reduce((sum, r) => sum + r.amount, 0);
  for (const payment of cashPayments) {
    // Ventes et acomptes/soldes de tickets de service encaissés en espèces.
    // (Les remboursements de créances clients ne sont pas rattachables à un
    // caissier — credit_repayments n'a ni utilisateur ni boutique — donc exclus.)
    if (payment.referenceType === "sale" || payment.referenceType === "service_order") net += payment.amount;
    else if (payment.referenceType === "refund") net -= payment.amount;
  }

  return session.openingAmount + net;
}

export interface CloseSessionInput {
  sessionId: number;
  closingAmount: number;
  // Ignoré : le montant attendu est TOUJOURS recalculé ici (un appelant ne doit
  // pas pouvoir choisir sa propre référence pour effacer un écart).
  expectedAmount?: number;
}

export interface CloseSessionResult {
  session: typeof schema.cashSessions.$inferSelect;
  expectedAmount: number;
  difference: number;
  // Vrai si |écart| dépasse le seuil des paramètres (tout écart si non défini).
  alert: boolean;
}

export async function closeSession(
  db: Database,
  input: CloseSessionInput,
  actingPermissions: PermissionSet,
) {
  requirePermission(actingPermissions, "manage_sales");
  const current = await db
    .select()
    .from(schema.cashSessions)
    .where(eq(schema.cashSessions.id, input.sessionId))
    .get();
  if (!current) throw new Error(t("coreErrors.cashSession.notFound"));
  if (current.closedAt) throw new Error(t("coreErrors.cashSession.alreadyClosed"));

  const expectedAmount = roundMoney(await getExpectedCashAmount(db, current));
  const closingAmount = roundMoney(input.closingAmount);
  const difference = roundMoney(closingAmount - expectedAmount);
  const settings = await getSettings(db);
  const alert = Math.abs(difference) > (settings.cashVarianceThreshold ?? 0);

  const session = await db
    .update(schema.cashSessions)
    .set({
      closingAmount,
      expectedAmount,
      // Même format que `openedAt` (défaut SQL CURRENT_TIMESTAMP : "YYYY-MM-DD
      // HH:MM:SS", UTC, sans millisecondes) — un .toISOString() brut produit
      // un format différent ("...T...Z" + ms) qui s'affichait de façon
      // incohérente à côté d'openedAt dans le rapport Caisse.
      closedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    })
    .where(eq(schema.cashSessions.id, input.sessionId))
    .returning()
    .get();

  await logAction(db, {
    userId: session.userId,
    action: "close_cash_session",
    entity: "cash_session",
    entityId: session.id,
    metadata: { closingAmount, expectedAmount, difference, alert },
  });

  return { session, expectedAmount, difference, alert } satisfies CloseSessionResult;
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
