// Test de restauration d'une sauvegarde : le fichier est ouvert dans une base séparée, en mémoire (jamais dans la
// vraie), et on vérifie qu'il est lisible et complet. Une sauvegarde qu'on n'a jamais essayé de rouvrir n'est qu'une
// espérance : on s'en aperçoit le jour où l'on en a besoin.

/** Tables sans lesquelles une sauvegarde ne permettrait pas de reprendre le commerce. */
export const REQUIRED_BACKUP_TABLES = ["users", "products", "sales", "business_settings"] as const;

export interface BackupProbe {
  /** Résultat de `PRAGMA integrity_check` (« ok » si le fichier est sain). */
  integrity: string;
  /** Nombre de lignes par table ; null si la table est absente ou illisible. */
  counts: Record<string, number | null>;
}

export interface BackupVerdict {
  ok: boolean;
  /** Code court de la cause, pour l'affichage (« integrity », « missing:users », « noUsers »...). */
  reason?: string;
}

export function evaluateBackupProbe(probe: BackupProbe): BackupVerdict {
  if (probe.integrity !== "ok") return { ok: false, reason: "integrity" };
  for (const table of REQUIRED_BACKUP_TABLES) {
    if (probe.counts[table] == null) return { ok: false, reason: `missing:${table}` };
  }
  // Un compte au moins : une base sans utilisateur ne permet pas de se connecter.
  if ((probe.counts.users ?? 0) < 1) return { ok: false, reason: "noUsers" };
  return { ok: true };
}

/** Deux suites d'octets identiques ? (comparaison du fichier relu après écriture) */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
