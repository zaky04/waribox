import type { Database } from "@gestion-boutique/database";
import { schema, withTransaction } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { and, desc, eq, inArray } from "drizzle-orm";
import { PermissionError, type PermissionSet } from "../domain/permissions";
import {
  assertCanDecide,
  assertWithinApproveLimit,
  canApprove,
  canApproveAnything,
  isReplicableRequest,
  snapshotApprovalRequest,
  type ApprovalKind,
} from "./ApprovalService";
import {
  buildSyncEvent,
  emitSyncEvent,
  type ApprovalRequestCreatedEventPayload,
  type ApprovalRequestDecidedEventPayload,
  type ApprovalRequestSnapshot,
  type SyncEvent,
} from "../sync/syncEvents";
import { logAction } from "./AuditService";
import { insertExpense } from "./ExpensesService";
import { applyPointsAdjustment } from "./LoyaltyService";
import { recordMovement } from "./StockService";

type ApprovalRequest = typeof schema.approvalRequests.$inferSelect;

export interface ListApprovalRequestsFilters {
  status?: "pending" | "approved" | "rejected";
  requestedBy?: number;
  limit?: number;
}

export async function listApprovalRequests(db: Database, filters: ListApprovalRequestsFilters = {}): Promise<ApprovalRequest[]> {
  const conditions = [];
  if (filters.status) conditions.push(eq(schema.approvalRequests.status, filters.status));
  if (filters.requestedBy != null) conditions.push(eq(schema.approvalRequests.requestedBy, filters.requestedBy));
  const query = db.select().from(schema.approvalRequests).orderBy(desc(schema.approvalRequests.id)).limit(filters.limit ?? 200);
  return conditions.length > 0 ? query.where(and(...conditions)) : query;
}

// Demandes en attente que CET utilisateur peut trancher (selon ses droits par domaine).
export async function listPendingFor(db: Database, permissions: PermissionSet): Promise<ApprovalRequest[]> {
  if (!canApproveAnything(permissions)) return [];
  const pending = await listApprovalRequests(db, { status: "pending" });
  return pending.filter((r) => canApprove(permissions, r.kind as ApprovalKind));
}

export async function countPendingFor(db: Database, permissions: PermissionSet): Promise<number> {
  return (await listPendingFor(db, permissions)).length;
}

// Décisions rendues sur les demandes de cette personne qu'elle n'a pas encore vues.
export async function listUnseenDecisions(db: Database, userId: number): Promise<ApprovalRequest[]> {
  return db
    .select()
    .from(schema.approvalRequests)
    .where(and(eq(schema.approvalRequests.requestedBy, userId), eq(schema.approvalRequests.decisionSeen, false)))
    .orderBy(desc(schema.approvalRequests.id));
}

export async function markDecisionsSeen(db: Database, userId: number): Promise<void> {
  await db
    .update(schema.approvalRequests)
    .set({ decisionSeen: true })
    .where(and(eq(schema.approvalRequests.requestedBy, userId), eq(schema.approvalRequests.decisionSeen, false)))
    .run();
}

// Effets d'une décision sur le stock, identiques sur tous les appareils : approuver
// confirme les mouvements déjà appliqués (approved_by), refuser les contre-passe par des
// mouvements inverses aux identifiants déterministes (donc jamais en double).
async function applyStockDecisionEffects(
  db: Database,
  request: { id: number; kind: string; syncId: string | null },
  payload: Record<string, any>,
  approve: boolean,
  deciderId: number,
): Promise<void> {
  if (request.kind !== "stock") return;
  const syncIds: string[] = Array.isArray(payload.movementSyncIds) ? payload.movementSyncIds : [];
  const ids: number[] = Array.isArray(payload.movementIds) ? payload.movementIds : [];
  const originals =
    syncIds.length > 0
      ? await db.select().from(schema.stockMovements).where(inArray(schema.stockMovements.syncId, syncIds))
      : ids.length > 0
        ? await db.select().from(schema.stockMovements).where(inArray(schema.stockMovements.id, ids))
        : [];
  if (originals.length === 0) return;
  if (approve) {
    await db.update(schema.stockMovements).set({ approvedBy: deciderId }).where(inArray(schema.stockMovements.id, originals.map((m) => m.id))).run();
    return;
  }
  for (const m of originals) {
    const reversalSyncId = `${request.syncId ?? request.id}:rev:${m.syncId ?? m.id}`;
    const done = await db.select({ id: schema.stockMovements.id }).from(schema.stockMovements).where(eq(schema.stockMovements.syncId, reversalSyncId)).get();
    if (done) continue;
    await recordMovement(db, {
      variantId: m.variantId,
      locationId: m.locationId,
      quantityDelta: -m.quantityDelta,
      movementType: "adjustment",
      referenceType: "approval_rejected",
      referenceId: request.id,
      batchId: m.batchId ?? undefined,
      userId: deciderId,
      note: t("approvalRequests.reversalNote", { id: request.id }),
      approvedBy: deciderId,
      syncId: reversalSyncId,
    });
  }
}

async function ensureRequestFromSnapshot(db: Database, snap: ApprovalRequestSnapshot): Promise<ApprovalRequest> {
  const existing = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.syncId, snap.syncId)).get();
  if (existing) return existing;
  if (snap.requestedBy != null) {
    const user = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, snap.requestedBy)).get();
    if (!user) throw new Error("demande de synchronisation : demandeur inconnu");
  }
  return db
    .insert(schema.approvalRequests)
    .values({
      syncId: snap.syncId,
      kind: snap.kind,
      amount: snap.amount,
      requestedBy: snap.requestedBy,
      storeId: snap.storeId,
      summary: snap.summary,
      payload: snap.payload,
      createdAt: snap.createdAt,
    })
    .returning()
    .get();
}

// Reçoit une demande créée sur un autre appareil (idempotent).
export async function applyApprovalRequestCreated(db: Database, payload: ApprovalRequestCreatedEventPayload): Promise<void> {
  await ensureRequestFromSnapshot(db, payload.request);
}

// Reçoit la décision prise sur un autre appareil. Idempotent ; revérifie que le
// décideur existe, a le droit d'approuver ce domaine, est dans son plafond et n'est
// pas le demandeur. La dépense éventuelle arrive par son propre événement
// (expense.created, mêmes identifiants) : ici seul l'état de la demande et les
// effets sur le stock sont appliqués.
export async function applyApprovalRequestDecided(db: Database, payload: ApprovalRequestDecidedEventPayload): Promise<void> {
  const request = await ensureRequestFromSnapshot(db, payload.request);
  if (request.status !== "pending") return;
  if (request.requestedBy === payload.decidedBy) throw new Error("décision de synchronisation : le demandeur ne peut pas trancher sa demande");
  await assertCanDecide(db, payload.decidedBy, request.kind as ApprovalKind, request.amount);
  const data = request.payload ? (JSON.parse(request.payload) as Record<string, any>) : {};
  await applyStockDecisionEffects(db, request, data, payload.approve, payload.decidedBy);
  await db
    .update(schema.approvalRequests)
    .set({
      status: payload.approve ? "approved" : "rejected",
      decidedBy: payload.decidedBy,
      decidedAt: payload.decidedAt,
      decisionNote: payload.note,
      decisionSeen: request.requestedBy == null,
    })
    .where(eq(schema.approvalRequests.id, request.id))
    .run();
}

export interface DecideApprovalRequestInput {
  requestId: number;
  approve: boolean;
  // Motif : obligatoire pour un refus.
  note?: string;
  userId: number;
}

// Tranche une demande. Approuver une demande « bloquée » (dépense, points)
// l'exécute maintenant ; approuver une demande « à valider ensuite » (stock)
// confirme l'effet déjà appliqué ; la refuser crée des mouvements inverses (le
// grand livre du stock ne s'efface jamais) ou abandonne simplement la demande.
export async function decideApprovalRequest(db: Database, input: DecideApprovalRequestInput, actingPermissions: PermissionSet) {
  const request = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, input.requestId)).get();
  if (!request) throw new Error(t("approvalRequests.errors.notFound"));
  if (request.status !== "pending") throw new Error(t("approvalRequests.errors.alreadyDecided"));
  if (!canApprove(actingPermissions, request.kind as ApprovalKind)) throw new PermissionError();
  if (request.requestedBy === input.userId) throw new PermissionError(t("approvalRequests.errors.selfDecision"));
  await assertWithinApproveLimit(db, input.userId, request.kind as ApprovalKind, request.amount);
  const note = input.note?.trim() || null;
  if (!input.approve && !note) throw new Error(t("approvalRequests.errors.reasonRequired"));

  const payload = request.payload ? (JSON.parse(request.payload) as Record<string, any>) : {};
  const decidedAt = new Date().toISOString().replace("T", " ").slice(0, 19);

  const markDecided = () =>
    db
      .update(schema.approvalRequests)
      .set({
        status: input.approve ? "approved" : "rejected",
        decidedBy: input.userId,
        decidedAt,
        decisionNote: note,
        decisionSeen: request.requestedBy == null,
      })
      .where(eq(schema.approvalRequests.id, request.id))
      .run();

  if (input.approve && request.kind === "expense") {
    // insertExpense ouvre sa propre transaction (les transactions ne s'imbriquent
    // pas ici) : on l'exécute seule, puis on marque la demande. Identifiants
    // déterministes : la dépense créée ici et celle qu'un autre appareil déduirait
    // de la décision sont la même (pas de doublon).
    await insertExpense(db, payload.input, input.userId, {
      expense: `${request.syncId}:expense`,
      payment: `${request.syncId}:payment`,
    });
    await markDecided();
  } else {
    await withTransaction(async () => {
      if (input.approve && request.kind === "points") await applyPointsAdjustment(db, payload.input, input.userId);
      else await applyStockDecisionEffects(db, request, payload, input.approve, input.userId);
      await markDecided();
    });
  }

  // Demande répliquable (dépense, stock manuel) : les autres appareils sont
  // informés de la décision — voir applyApprovalRequestDecided.
  if (isReplicableRequest(request.kind, payload) && request.syncId) {
    emitSyncEvent(
      buildSyncEvent<ApprovalRequestDecidedEventPayload>("approvalRequest.decided", {
        request: snapshotApprovalRequest(request),
        approve: input.approve,
        decidedBy: input.userId,
        note,
        decidedAt,
      }),
    );
  }

  await logAction(db, {
    userId: input.userId,
    action: input.approve ? "approval_request_approved" : "approval_request_rejected",
    entity: "approval_request",
    entityId: request.id,
    metadata: { kind: request.kind, amount: request.amount, requestedBy: request.requestedBy, note, summary: request.summary },
  });
}
