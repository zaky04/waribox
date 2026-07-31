import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { desc, eq } from "drizzle-orm";
import { logAction } from "./AuditService";

// Taux symétrique : `ratio` points gagnés par unité de devise dépensée, et
// la valeur de rachat d'un point est l'inverse exact (1 / ratio en devise).
export function pointsToDiscount(points: number, ratio: number): number {
  return ratio > 0 ? points / ratio : 0;
}

export async function listLoyaltyTransactions(db: Database, customerId: number) {
  return db
    .select()
    .from(schema.loyaltyTransactions)
    .where(eq(schema.loyaltyTransactions.customerId, customerId))
    .orderBy(desc(schema.loyaltyTransactions.id));
}

export interface RedeemPointsInput {
  customerId: number;
  points: number;
  saleId?: number;
  ratio: number;
}

export async function redeemPoints(db: Database, input: RedeemPointsInput) {
  const customer = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, input.customerId))
    .get();

  if (!customer) {
    throw new Error("Client introuvable.");
  }
  if (input.points <= 0) {
    throw new Error("Le nombre de points à utiliser doit être supérieur à zéro.");
  }
  if (input.points > customer.loyaltyPoints) {
    throw new Error(`Le client ne dispose que de ${customer.loyaltyPoints} points.`);
  }

  await db.insert(schema.loyaltyTransactions).values({
    customerId: input.customerId,
    pointsDelta: -input.points,
    reason: "redemption",
    referenceId: input.saleId,
  });

  return db
    .update(schema.customers)
    .set({ loyaltyPoints: customer.loyaltyPoints - input.points })
    .where(eq(schema.customers.id, input.customerId))
    .returning()
    .get();
}

export interface EarnPointsInput {
  customerId: number;
  amount: number;
  saleId?: number;
  ratio: number;
}

export async function earnPoints(db: Database, input: EarnPointsInput) {
  const points = input.amount * input.ratio;
  if (points <= 0) return;

  const customer = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, input.customerId))
    .get();
  if (!customer) return;

  await db.insert(schema.loyaltyTransactions).values({
    customerId: input.customerId,
    pointsDelta: points,
    reason: "purchase",
    referenceId: input.saleId,
  });

  await db
    .update(schema.customers)
    .set({ loyaltyPoints: customer.loyaltyPoints + points })
    .where(eq(schema.customers.id, input.customerId))
    .run();
}

export interface AdjustPointsInput {
  customerId: number;
  pointsDelta: number;
  userId: number;
  reason?: string;
}

export async function adjustPoints(db: Database, input: AdjustPointsInput) {
  const customer = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, input.customerId))
    .get();
  if (!customer) {
    throw new Error("Client introuvable.");
  }
  if (input.pointsDelta === 0) {
    throw new Error("Le delta de points doit être différent de zéro.");
  }
  const newBalance = customer.loyaltyPoints + input.pointsDelta;
  if (newBalance < 0) {
    throw new Error(`Le client ne dispose que de ${customer.loyaltyPoints} points.`);
  }

  await db.insert(schema.loyaltyTransactions).values({
    customerId: input.customerId,
    pointsDelta: input.pointsDelta,
    reason: "manual_adjustment",
  });

  const updated = await db
    .update(schema.customers)
    .set({ loyaltyPoints: newBalance })
    .where(eq(schema.customers.id, input.customerId))
    .returning()
    .get();

  await logAction(db, {
    userId: input.userId,
    action: "adjust_loyalty_points",
    entity: "customer",
    entityId: input.customerId,
    metadata: { pointsDelta: input.pointsDelta, reason: input.reason, newBalance },
  });

  return updated;
}
