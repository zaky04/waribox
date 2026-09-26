import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { logAction } from "./AuditService";
import { getSettings } from "./SettingsService";

// « Contrôle effectué » : le propriétaire marque le moment où il a passé en revue
// le journal et les alertes. Il ne revoit ensuite que ce qui s'est passé depuis.
export interface ControlsReviewStatus {
  reviewedAt: string | null;
  reviewedBy: number | null;
  reviewedByName: string | null;
  // Actions enregistrées au journal depuis le dernier contrôle (hors contrôles eux-mêmes).
  eventsSince: number;
  pendingRequests: number;
}

export async function getControlsReviewStatus(db: Database): Promise<ControlsReviewStatus> {
  const settings = await getSettings(db);
  const reviewedAt = settings.controlsReviewedAt ?? null;
  const reviewedBy = settings.controlsReviewedBy ?? null;
  const reviewer = reviewedBy != null ? await db.select({ name: schema.users.fullName }).from(schema.users).where(eq(schema.users.id, reviewedBy)).get() : undefined;
  const conditions = [ne(schema.auditLog.action, "controls_reviewed")];
  if (reviewedAt) conditions.push(gt(schema.auditLog.createdAt, reviewedAt));
  const events = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.auditLog)
    .where(and(...conditions))
    .get();
  const pending = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.approvalRequests)
    .where(eq(schema.approvalRequests.status, "pending"))
    .get();
  return {
    reviewedAt,
    reviewedBy,
    reviewedByName: reviewer?.name ?? null,
    eventsSince: Number(events?.n ?? 0),
    pendingRequests: Number(pending?.n ?? 0),
  };
}

export async function markControlsReviewed(db: Database, userId: number, actingPermissions: PermissionSet, note?: string): Promise<string> {
  requirePermission(actingPermissions, "view_controls");
  const settings = await getSettings(db);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  await db
    .update(schema.businessSettings)
    .set({ controlsReviewedAt: now, controlsReviewedBy: userId })
    .where(eq(schema.businessSettings.id, settings.id))
    .run();
  await logAction(db, {
    userId,
    action: "controls_reviewed",
    entity: "controls",
    metadata: { previous: settings.controlsReviewedAt ?? null, note: note?.trim() || null },
  });
  return now;
}
