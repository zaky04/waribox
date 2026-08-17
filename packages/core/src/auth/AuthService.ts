import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { eq } from "drizzle-orm";
import { requirePermission, type PermissionSet } from "../domain/permissions";
import { logAction } from "../services/AuditService";
import { hashSecret, verifySecret } from "./hash";

export interface AuthenticatedUser {
  id: number;
  fullName: string;
  username: string | null;
  email: string | null;
  roleId: number;
  roleName: string;
  permissions: PermissionSet;
  isActive: boolean;
  // Boutique à laquelle ce compte est cantonné (voir schema/users.ts) — nul
  // pour Admin/Propriétaire ou en mono-boutique.
  storeId: number | null;
}

async function toAuthenticatedUser(
  db: Database,
  user: typeof schema.users.$inferSelect,
): Promise<AuthenticatedUser> {
  const role = await db.select().from(schema.roles).where(eq(schema.roles.id, user.roleId)).get();
  return {
    id: user.id,
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    roleId: user.roleId,
    roleName: role?.name ?? "",
    permissions: role ? (JSON.parse(role.permissions) as PermissionSet) : {},
    isActive: user.isActive,
    storeId: user.storeId,
  };
}

// Anti-brute-force : même compteur pour le mot de passe et le code PIN,
// puisqu'ils protègent le même compte. Verrouillage court (30s) plutôt
// qu'un blocage définitif — ralentit une attaque automatisée sans jamais
// nécessiter l'intervention d'un administrateur pour un oubli ordinaire.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;

function remainingLockSeconds(lockedUntil: string | null): number {
  if (!lockedUntil) return 0;
  const until = new Date(`${lockedUntil.replace(" ", "T")}Z`).getTime();
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

async function registerFailedAttempt(db: Database, userId: number, currentAttempts: number): Promise<void> {
  const attempts = currentAttempts + 1;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString().replace("T", " ").slice(0, 19);
    await db.update(schema.users).set({ failedAttempts: 0, lockedUntil }).where(eq(schema.users.id, userId)).run();
  } else {
    await db.update(schema.users).set({ failedAttempts: attempts }).where(eq(schema.users.id, userId)).run();
  }
}

async function clearFailedAttempts(db: Database, userId: number): Promise<void> {
  await db
    .update(schema.users)
    .set({ failedAttempts: 0, lockedUntil: null })
    .where(eq(schema.users.id, userId))
    .run();
}

export async function hasAnyUser(db: Database): Promise<boolean> {
  const existing = await db.select({ id: schema.users.id }).from(schema.users).limit(1).get();
  return existing !== undefined;
}

export async function createUser(
  db: Database,
  input: {
    fullName: string;
    username: string;
    email?: string;
    password: string;
    pin?: string;
    roleId: number;
    storeId?: number | null;
    createdBy?: number;
  },
  actingPermissions: PermissionSet,
): Promise<AuthenticatedUser> {
  // Aucune vérification si la base ne contient encore aucun compte — c'est
  // le tout premier compte (Admin) créé par SetupAdminScreen, avant qu'une
  // session ne puisse exister.
  if (await hasAnyUser(db)) {
    requirePermission(actingPermissions, "manage_users");
  }

  // Normalisé (espaces + casse) pour que "Admin" et "admin" désignent le même
  // compte à la connexion — évite un motif de support récurrent.
  const username = input.username.trim().toLowerCase();

  // Pas de contrainte UNIQUE fiable en base pour username (voir le schéma) —
  // vérification côté application, uniforme pour toute installation.
  const existing = await db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  if (existing) {
    throw new Error(t("coreErrors.auth.usernameTaken"));
  }

  const passwordHash = await hashSecret(input.password);
  const pinHash = input.pin ? await hashSecret(input.pin) : null;

  const created = await db
    .insert(schema.users)
    .values({
      fullName: input.fullName,
      username,
      email: input.email,
      passwordHash,
      pinHash,
      roleId: input.roleId,
      storeId: input.storeId,
    })
    .returning()
    .get();

  if (input.createdBy) {
    await logAction(db, {
      userId: input.createdBy,
      action: "create_user",
      entity: "user",
      entityId: created.id,
      metadata: { fullName: created.fullName, roleId: created.roleId },
    });
  }

  return toAuthenticatedUser(db, created);
}

export async function listUsers(db: Database): Promise<AuthenticatedUser[]> {
  const users = await db.select().from(schema.users);
  return Promise.all(users.map((user) => toAuthenticatedUser(db, user)));
}

export async function listRoles(db: Database) {
  return db.select().from(schema.roles);
}

// `identifier` est le pseudo (nouveau, prioritaire) ou l'email (comptes créés
// avant l'ajout du pseudo, qui n'en ont pas encore) — cherche d'abord par
// pseudo, retombe sur l'email si aucun compte ne correspond.
export async function verifyPassword(
  db: Database,
  identifier: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const trimmed = identifier.trim();
  // Le pseudo est normalisé en minuscules à la création (voir createUser),
  // donc comparé ainsi ; l'email garde la casse exacte saisie par
  // l'utilisateur pour ne rien changer au comportement des comptes déjà
  // créés avant l'ajout du pseudo.
  const user =
    (await db.select().from(schema.users).where(eq(schema.users.username, trimmed.toLowerCase())).get()) ??
    (await db.select().from(schema.users).where(eq(schema.users.email, trimmed)).get());

  if (!user || !user.passwordHash || !user.isActive) return null;

  const lockedSeconds = remainingLockSeconds(user.lockedUntil);
  if (lockedSeconds > 0) {
    throw new Error(t("coreErrors.common.tooManyAttempts", { seconds: lockedSeconds }));
  }

  const valid = await verifySecret(password, user.passwordHash);
  if (!valid) {
    await registerFailedAttempt(db, user.id, user.failedAttempts);
    return null;
  }

  await clearFailedAttempts(db, user.id);
  return toAuthenticatedUser(db, user);
}

export async function verifyPin(db: Database, userId: number, pin: string): Promise<boolean> {
  const user = await db
    .select({
      pinHash: schema.users.pinHash,
      failedAttempts: schema.users.failedAttempts,
      lockedUntil: schema.users.lockedUntil,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();

  if (!user?.pinHash) return false;

  const lockedSeconds = remainingLockSeconds(user.lockedUntil);
  if (lockedSeconds > 0) {
    throw new Error(t("coreErrors.common.tooManyAttempts", { seconds: lockedSeconds }));
  }

  const valid = await verifySecret(pin, user.pinHash);
  if (!valid) {
    await registerFailedAttempt(db, userId, user.failedAttempts);
    return false;
  }

  await clearFailedAttempts(db, userId);
  return true;
}

export async function setPin(db: Database, userId: number, pin: string): Promise<void> {
  const pinHash = await hashSecret(pin);
  await db.update(schema.users).set({ pinHash }).where(eq(schema.users.id, userId)).run();
}

// Désactiver un compte bloque immédiatement la connexion (verifyPassword
// refuse déjà tout utilisateur avec isActive=false) — pas de session active à
// invalider séparément puisque cette app ne gère pas de jetons persistants.
export async function setUserActive(
  db: Database,
  userId: number,
  isActive: boolean,
  actingPermissions: PermissionSet,
  updatedBy?: number,
): Promise<void> {
  requirePermission(actingPermissions, "manage_users");
  await db.update(schema.users).set({ isActive }).where(eq(schema.users.id, userId)).run();

  if (updatedBy) {
    await logAction(db, {
      userId: updatedBy,
      action: isActive ? "activate_user" : "deactivate_user",
      entity: "user",
      entityId: userId,
    });
  }
}

export async function getUserById(db: Database, userId: number): Promise<AuthenticatedUser | null> {
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return null;
  return toAuthenticatedUser(db, user);
}

// Libre-service : n'importe quel utilisateur connecté change son propre mot
// de passe, à condition de connaître l'actuel — aucune permission
// particulière requise puisque ça ne touche que son propre compte.
export async function changeOwnPassword(
  db: Database,
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user?.passwordHash) {
    throw new Error(t("coreErrors.auth.accountNotFound"));
  }

  const lockedSeconds = remainingLockSeconds(user.lockedUntil);
  if (lockedSeconds > 0) {
    throw new Error(t("coreErrors.common.tooManyAttempts", { seconds: lockedSeconds }));
  }

  const valid = await verifySecret(currentPassword, user.passwordHash);
  if (!valid) {
    await registerFailedAttempt(db, userId, user.failedAttempts);
    throw new Error(t("coreErrors.auth.wrongCurrentPassword"));
  }
  await clearFailedAttempts(db, userId);

  const passwordHash = await hashSecret(newPassword);
  await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId)).run();
}

export interface UpdateUserInput {
  fullName?: string;
  username?: string;
  email?: string;
  roleId?: number;
  storeId?: number | null;
  // Réinitialisation par l'Admin — contrairement à changeOwnPassword, ne
  // demande jamais l'ancien mot de passe (c'est justement l'intérêt : un
  // utilisateur qui l'a oublié).
  newPassword?: string;
}

// Édition par un Admin (permission manage_users) — distinct de
// changeOwnPassword qui n'exige aucune permission mais ne peut modifier que
// son propre compte, jamais celui d'un autre.
export async function updateUser(
  db: Database,
  userId: number,
  input: UpdateUserInput,
  actingPermissions: PermissionSet,
  updatedBy?: number,
): Promise<AuthenticatedUser> {
  requirePermission(actingPermissions, "manage_users");

  const updates: Partial<typeof schema.users.$inferInsert> = {};
  if (input.fullName !== undefined) updates.fullName = input.fullName;
  if (input.email !== undefined) updates.email = input.email;
  if (input.roleId !== undefined) updates.roleId = input.roleId;
  if (input.storeId !== undefined) updates.storeId = input.storeId;

  if (input.username !== undefined) {
    const username = input.username.trim().toLowerCase();
    const existing = await db.select().from(schema.users).where(eq(schema.users.username, username)).get();
    if (existing && existing.id !== userId) {
      throw new Error(t("coreErrors.auth.usernameTaken"));
    }
    updates.username = username;
  }

  if (input.newPassword) {
    updates.passwordHash = await hashSecret(input.newPassword);
  }

  const updated = await db.update(schema.users).set(updates).where(eq(schema.users.id, userId)).returning().get();
  if (!updated) {
    throw new Error(t("coreErrors.auth.userNotFound"));
  }

  if (updatedBy) {
    await logAction(db, {
      userId: updatedBy,
      action: "update_user",
      entity: "user",
      entityId: userId,
      metadata: { fullName: updated.fullName, roleId: updated.roleId, passwordReset: !!input.newPassword },
    });
  }

  return toAuthenticatedUser(db, updated);
}

// Permet à un Admin d'ouvrir une session en tant qu'un autre utilisateur
// sans connaître son mot de passe (dépannage, vérification d'un rôle...) —
// jamais l'inverse d'une connexion normale : aucun mot de passe n'est
// vérifié ici, seule la permission manage_users de l'Admin l'autorise.
// L'action est journalisée avec l'identité de l'Admin (userId) et celle du
// compte visé (entityId) pour rester traçable.
export async function impersonateUser(
  db: Database,
  targetUserId: number,
  actingPermissions: PermissionSet,
  actingUserId: number,
): Promise<AuthenticatedUser> {
  requirePermission(actingPermissions, "manage_users");

  const target = await getUserById(db, targetUserId);
  if (!target) {
    throw new Error(t("coreErrors.auth.userNotFound"));
  }
  if (!target.isActive) {
    throw new Error(t("coreErrors.auth.accountDisabled"));
  }

  await logAction(db, {
    userId: actingUserId,
    action: "impersonate_user",
    entity: "user",
    entityId: targetUserId,
    metadata: { targetFullName: target.fullName },
  });

  return target;
}
