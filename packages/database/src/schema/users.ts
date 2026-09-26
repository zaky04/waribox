import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { stores } from "./stores";

export const roles = sqliteTable("roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  // JSON: { "view_margins": true, "manage_stock": true, ... }
  permissions: text("permissions").notNull(),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fullName: text("full_name").notNull(),
  // Identifiant de connexion simple ("pseudo") — pas de contrainte UNIQUE en
  // base pour les installations migrées (SQLite interdit UNIQUE sur un
  // ALTER TABLE ADD COLUMN) : l'unicité est vérifiée côté application dans
  // AuthService.createUser, uniformément pour les installs neuves et migrées.
  username: text("username"),
  email: text("email").unique(),
  passwordHash: text("password_hash"),
  pinHash: text("pin_hash"),
  biometricCredentialId: text("biometric_credential_id"),
  roleId: integer("role_id")
    .notNull()
    .references(() => roles.id),
  // Boutique à laquelle ce compte est cantonné — nul pour Admin/Propriétaire
  // (accès à toutes les boutiques via switch_store) et pour les installations
  // mono-boutique. Pour Gérant/Vendeur/Caissier avec le multi-boutique actif,
  // détermine la boutique de travail imposée à la connexion (voir
  // AuthGate.tsx) : ces rôles n'ont pas la permission switch_store et ne
  // peuvent donc jamais en changer eux-mêmes.
  storeId: integer("store_id").references(() => stores.id),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  // Anti-brute-force sur le mot de passe ET le code PIN (même compteur pour
  // les deux — ils protègent le même compte). lockedUntil est effacé dès
  // qu'une tentative réussit ou que le délai est écoulé.
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: text("locked_until"),
  // Plafonds personnels (NULL = utiliser le seuil global des paramètres) —
  // au-delà, l'action exige l'approbation d'un responsable.
  // Droits particuliers de cet utilisateur, par-dessus ceux de son rôle :
  // JSON { "manage_stock": true, "manage_refunds": false }. true accorde, false
  // retire ; une permission absente suit le rôle. NULL = aucun droit particulier.
  permissionOverrides: text("permission_overrides"),
  limitRefund: real("limit_refund"),
  limitStock: real("limit_stock"),
  limitDiscount: real("limit_discount"),
  limitExpense: real("limit_expense"),
  limitPoints: real("limit_points"),
  limitTicket: real("limit_ticket"),
  limitCredit: real("limit_credit"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
