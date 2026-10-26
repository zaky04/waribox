import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";

// Anti-brute-force partagé par le mot de passe et le code PIN (même compteur :
// ils protègent le même compte). Verrouillage PROGRESSIF et compteur qui ne
// repart à zéro qu'après une réussite : avec une pause fixe de 30 s et un
// compteur remis à zéro à chaque verrou, un code à 4 chiffres tombait en moins
// d'une journée ; ici, de la 5e erreur à la 9e on attend 30 s entre deux essais,
// puis 5 min, 30 min, 1 h.
export const MAX_FAILED_ATTEMPTS = 5;

export function lockoutSecondsForAttempts(attempts: number): number {
  if (attempts < MAX_FAILED_ATTEMPTS) return 0;
  if (attempts < 10) return 30;
  if (attempts < 15) return 5 * 60;
  if (attempts < 20) return 30 * 60;
  return 60 * 60;
}

export function remainingLockSeconds(lockedUntil: string | null): number {
  if (!lockedUntil) return 0;
  const until = new Date(`${lockedUntil.replace(" ", "T")}Z`).getTime();
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

export async function registerFailedAttempt(db: Database, userId: number, currentAttempts: number): Promise<void> {
  const attempts = currentAttempts + 1;
  const lockSeconds = lockoutSecondsForAttempts(attempts);
  const lockedUntil = lockSeconds > 0 ? new Date(Date.now() + lockSeconds * 1000).toISOString().replace("T", " ").slice(0, 19) : null;
  await db
    .update(schema.users)
    .set(lockedUntil ? { failedAttempts: attempts, lockedUntil } : { failedAttempts: attempts })
    .where(eq(schema.users.id, userId))
    .run();
}

export async function clearFailedAttempts(db: Database, userId: number): Promise<void> {
  await db.update(schema.users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(schema.users.id, userId)).run();
}
