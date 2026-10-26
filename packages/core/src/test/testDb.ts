import { createDatabase, setDatabaseBackend, type Database, type DatabaseBackend } from "@gestion-boutique/database";
import { createRequire } from "node:module";

// Vraie base SQLite pour les tests d'intégration : le bootstrap, les migrations,
// `withTransaction` et drizzle tournent tels quels, seul le moteur est remplacé
// (node:sqlite, en mémoire) par la couture `setDatabaseBackend` du package
// database. `createRequire` plutôt qu'un import statique : Vite ne connaît pas
// encore `node:sqlite` comme module natif.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface TestDevice {
  readonly name: string;
  readonly backend: DatabaseBackend;
  db: Database | null;
}

function makeBackend(): DatabaseBackend {
  const sqlite = new DatabaseSync(":memory:");
  return async (type, payload) => {
    if (type !== "exec") throw new Error(`testDb: opération non supportée : ${type}`);
    const statement = sqlite.prepare(payload.sql as string);
    statement.setReturnArrays(true);
    const bind = ((payload.bind as unknown[] | undefined) ?? []).map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v));
    const resultRows = statement.all(...(bind as never[])) as unknown as unknown[][];
    return { resultRows };
  };
}

/**
 * Crée un « appareil » : une base SQLite vierge, bootstrap et migrations
 * appliqués. Une seule base est active à la fois (le moteur est global) : avant
 * toute opération sur un autre appareil, appeler `useDevice`.
 */
export async function createDevice(name = "device"): Promise<TestDevice> {
  const device: TestDevice = { name, backend: makeBackend(), db: null };
  setDatabaseBackend(device.backend);
  device.db = await createDatabase();
  return device;
}

/** Rend cet appareil actif et renvoie sa base. */
export function useDevice(device: TestDevice): Database {
  setDatabaseBackend(device.backend);
  return device.db!;
}

export function releaseDevices(): void {
  setDatabaseBackend(null);
}
