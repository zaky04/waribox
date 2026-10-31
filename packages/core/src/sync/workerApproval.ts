import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { applyOverrides, parseOverrides, type PermissionSet } from "../domain/permissions";
import { checkApproval, checkCreditApproval, getApprovalMode } from "../services/ApprovalService";
import { pointsToDiscount } from "../services/LoyaltyService";
import { computeUnauthorizedDiscountForItems } from "../services/SalesService";
import { getSettings } from "../services/SettingsService";
import { valueAtCost } from "../services/StockService";
import type { ExpenseCreatedEventPayload, SaleCreatedEventPayload, StockEntryCreatedEventPayload, StockLossCreatedEventPayload, SyncEvent } from "./syncEvents";

// Revalidation, par le Maître, des approbations d'une action faite sur un appareil relié.
//
// L'appareil relié a appliqué lui-même les règles (seuils, PIN d'un responsable) avant
// de produire l'événement, mais le Maître ne doit pas le croire sur parole : une fois le
// jeton de pairage connu, n'importe quel client peut forger la trame. Le Maître refait donc
// le calcul « cette action dépasse-t-elle un seuil ? » avec SES réglages, et si oui exige
// un responsable dont le PIN a été vérifié par lui (voir approvalGrants.ts).
//
// Limites assumées :
//  - un domaine en « validation ultérieure » (stock) accepte l'action sans approbation : la
//    demande d'approbation suit dans un autre événement, que ce contrôle ne peut pas relier
//    avec certitude ;
//  - l'autorisation d'un PIN n'est pas liée à UNE opération (elle vaut 5 minutes, une fois,
//    dans les limites du responsable) ;
//  - les dérogations de lot périmé et les autres actions non répliquées ne passent pas ici.

/** Types d'événements qui peuvent exiger une approbation. */
export const APPROVAL_GATED_EVENT_TYPES: ReadonlySet<SyncEvent["type"]> = new Set(["expense.created", "sale.created", "stockEntry.created", "stockLoss.created"]);

/** La ligne racine de cet événement existe-t-elle déjà ? (un renvoi après un accusé perdu ne doit pas être refusé) */
export async function isEventAlreadyApplied(db: Database, event: SyncEvent): Promise<boolean> {
  switch (event.type) {
    case "sale.created": {
      const id = (event.payload as SaleCreatedEventPayload).sale.syncId;
      return !!(await db.select({ id: schema.sales.id }).from(schema.sales).where(eq(schema.sales.syncId, id)).get());
    }
    case "expense.created": {
      const id = (event.payload as ExpenseCreatedEventPayload).expense.syncId;
      return !!(await db.select({ id: schema.expenses.id }).from(schema.expenses).where(eq(schema.expenses.syncId, id)).get());
    }
    case "stockEntry.created":
    case "stockLoss.created": {
      const id = (event.payload as StockEntryCreatedEventPayload | StockLossCreatedEventPayload).movement.syncId;
      return !!(await db.select({ id: schema.stockMovements.id }).from(schema.stockMovements).where(eq(schema.stockMovements.syncId, id)).get());
    }
    default:
      return false;
  }
}

async function loadActorPermissions(db: Database, userId: number | null | undefined): Promise<PermissionSet> {
  if (userId == null) return {};
  const row = await db
    .select({ permissions: schema.roles.permissions, overrides: schema.users.permissionOverrides })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.users.id, userId))
    .get();
  return row ? applyOverrides(JSON.parse(row.permissions) as PermissionSet, parseOverrides(row.overrides)) : {};
}

/**
 * Lève une erreur si cette action exigeait une approbation que l'événement ne prouve pas.
 * `verifiedApproverId` : le responsable dont le Maître a lui-même vérifié le PIN pour cet
 * appareil (autorisation valide), sinon null.
 */
export async function assertWorkerEventApproved(db: Database, event: SyncEvent, verifiedApproverId: number | null): Promise<void> {
  switch (event.type) {
    case "expense.created": {
      const { expense } = event.payload as ExpenseCreatedEventPayload;
      const userId = expense.userId ?? undefined;
      await checkApproval(db, { kind: "expense", amount: expense.amount, userId, actingPermissions: await loadActorPermissions(db, userId), verifiedApproverId });
      return;
    }
    case "stockEntry.created":
    case "stockLoss.created": {
      const { movement } = event.payload as StockEntryCreatedEventPayload | StockLossCreatedEventPayload;
      const userId = event.actorId ?? undefined;
      // Validation ultérieure : le mouvement s'applique tout de suite, la demande suit (voir en-tête).
      if (verifiedApproverId == null && (await getApprovalMode(db, "stock")) === "later") return;
      const amount = await valueAtCost(db, movement.variantId, movement.quantityDelta);
      await checkApproval(db, { kind: "stock", amount, userId, actingPermissions: await loadActorPermissions(db, userId), verifiedApproverId });
      return;
    }
    case "sale.created": {
      const payload = event.payload as SaleCreatedEventPayload;
      const { sale } = payload;
      const settings = await getSettings(db);
      const actingPermissions = await loadActorPermissions(db, sale.userId);

      // Remise hors promotion (même calcul que createSale, sur les lignes de l'événement).
      const redemptionDiscount = payload.loyaltyRedeem ? pointsToDiscount(Math.abs(payload.loyaltyRedeem.pointsDelta), settings.loyaltyPointsRatio) : 0;
      const invoiceDiscount = Math.max(0, sale.discount - redemptionDiscount);
      const unauthorized = await computeUnauthorizedDiscountForItems(db, settings, payload.items, invoiceDiscount);
      if (unauthorized > 0) {
        await checkApproval(db, { kind: "discount", amount: unauthorized, userId: sale.userId, actingPermissions, verifiedApproverId });
      }

      // Part à crédit (plafond du client et seuil d'approbation).
      const creditAmount = payload.credit?.originalAmount ?? 0;
      if (creditAmount > 0.005) {
        const customer = sale.customerSyncId
          ? await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.syncId, sale.customerSyncId)).get()
          : undefined;
        // Un client créé par cette vente n'a pas encore d'identifiant local : -1 = « aucun encours connu ».
        await checkCreditApproval(db, { customerId: customer?.id ?? -1, creditAmount, userId: sale.userId, actingPermissions, verifiedApproverId });
      }
      return;
    }
    default:
      return;
  }
}
