import { DEFAULT_ROLES, hashSecret, mergeMissingPermissions, type PermissionSet } from "@gestion-boutique/core";
import { BOOTSTRAP_SQL, MIGRATION_SQL } from "@gestion-boutique/database";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync } from "node:fs";

// Script de secours : applique hors-ligne, sur une sauvegarde .sqlite3
// exportée par l'app (Paramètres > Sauvegardes), les mêmes migrations de
// schéma et le même rattrapage de permissions que l'app applique
// automatiquement au démarrage — pour le cas où l'accès à l'app elle-même
// est bloqué (mot de passe perdu, compte désactivé). Le fichier produit doit
// être réimporté dans l'app via Paramètres > Sauvegardes > Importer une
// sauvegarde.
//
// N'agit jamais sur le stockage OPFS interne de l'app directement — ce n'est
// pas un fichier ouvrable simplement par un outil externe (voir le plan).
//
// Utilise node:sqlite (module intégré à Node.js ≥ 22.5, aucune dépendance
// externe) plutôt qu'un module natif type better-sqlite3 (échec de
// compilation constaté sur cette machine faute d'outillage MSVC/ClangCL) ou
// @sqlite.org/sqlite-wasm côté Node (n'écrit pas de façon fiable sur le vrai
// système de fichiers dans cet environnement, contrairement à node:sqlite).

interface RoleRow {
  id: number;
  name: string;
  permissions: string;
}

function parseArgs(argv: string[]) {
  const [backupPath, ...rest] = argv;
  let resetAdminPassword: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--reset-admin-password") {
      resetAdminPassword = rest[i + 1];
      i++;
    }
  }
  return { backupPath, resetAdminPassword };
}

async function main() {
  const { backupPath, resetAdminPassword } = parseArgs(process.argv.slice(2));

  if (!backupPath) {
    console.error(
      "Usage : pnpm --filter @gestion-boutique/maintenance-cli start -- <chemin-sauvegarde.sqlite3> " +
        "[--reset-admin-password <nouveau-mot-de-passe>]",
    );
    process.exit(1);
  }
  if (!existsSync(backupPath)) {
    console.error(`Fichier introuvable : ${backupPath}`);
    process.exit(1);
  }

  const backupCopyPath = `${backupPath}.bak-${Date.now()}`;
  copyFileSync(backupPath, backupCopyPath);
  console.log(`Copie de sécurité créée : ${backupCopyPath}`);

  const db = new DatabaseSync(backupPath);

  try {
    console.log("Application du schéma de base (idempotent)...");
    for (const statement of BOOTSTRAP_SQL) {
      db.exec(statement);
    }

    console.log("Application des migrations...");
    let migrationsApplied = 0;
    for (const statement of MIGRATION_SQL) {
      try {
        db.exec(statement);
        migrationsApplied++;
      } catch {
        // Colonne déjà présente — même comportement que l'app (client.ts).
      }
    }
    console.log(`${migrationsApplied} migration(s) appliquée(s) (les autres étaient déjà présentes).`);

    console.log("Rattrapage des permissions de rôle...");
    const roles = db.prepare("SELECT id, name, permissions FROM roles").all() as unknown as RoleRow[];

    let rolesUpdated = 0;
    for (const defaultRole of Object.values(DEFAULT_ROLES)) {
      const existing = roles.find((r) => r.name === defaultRole.name);
      if (!existing) continue;
      const currentPermissions = JSON.parse(existing.permissions) as PermissionSet;
      const { merged, changed } = mergeMissingPermissions(currentPermissions, defaultRole.permissions);
      if (changed) {
        db.prepare("UPDATE roles SET permissions = ? WHERE id = ?").run(JSON.stringify(merged), existing.id);
        rolesUpdated++;
      }
    }
    console.log(`${rolesUpdated} rôle(s) mis à jour.`);

    if (resetAdminPassword) {
      if (resetAdminPassword.length < 8) {
        console.error("Le nouveau mot de passe doit contenir au moins 8 caractères.");
        process.exitCode = 1;
      } else {
        const adminRole = roles.find((r) => r.name === "Admin");
        if (!adminRole) {
          console.error("Aucun rôle Admin trouvé dans cette sauvegarde.");
        } else {
          const passwordHash = await hashSecret(resetAdminPassword);
          db.prepare("UPDATE users SET password_hash = ? WHERE role_id = ?").run(passwordHash, adminRole.id);
          console.log("Mot de passe réinitialisé pour le(s) compte(s) du rôle Admin.");
        }
      }
    }

    console.log(
      "Terminé. Réimporte ce fichier dans l'app via Paramètres > Sauvegardes > Importer une sauvegarde.",
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
