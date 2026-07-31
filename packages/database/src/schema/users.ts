import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  // Anti-brute-force sur le mot de passe ET le code PIN (même compteur pour
  // les deux — ils protègent le même compte). lockedUntil est effacé dès
  // qu'une tentative réussit ou que le délai est écoulé.
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: text("locked_until"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
