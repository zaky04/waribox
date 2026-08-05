import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { BOOTSTRAP_SQL } from "./bootstrap-sql";
import * as schema from "./schema";

interface WorkerResponse {
  id?: number;
  type?: string;
  resultRows?: unknown[][];
  bytes?: Uint8Array;
  error?: string;
}

let workerPromise: Promise<Worker> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void }>();

// db-worker.js (copié tel quel par apps/web/vite.config.ts, non bundlé par
// Vite/Rollup) fait tourner sqlite-wasm avec le VFS OPFS SAH-pool dans un seul
// worker — pas de worker imbriqué comme l'ancien VFS OPFS classique, qui
// échouait sous le protocole interne de Tauri (WebView2) même avec
// crossOriginIsolated à true. Voir packages/database/src/sahpool-worker.js.
function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = new Promise((resolve) => {
      const worker = new Worker("/db-worker.js", { type: "module" });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const data = event.data;
        if (data.type === "ready") {
          resolve(worker);
          return;
        }
        if (data.id === undefined) return;
        const handler = pending.get(data.id);
        if (!handler) return;
        pending.delete(data.id);
        if (data.error) handler.reject(new Error(data.error));
        else handler.resolve(data);
      };
    });
  }
  return workerPromise;
}

async function callWorker(type: string, payload: Record<string, unknown> = {}): Promise<WorkerResponse> {
  const worker = await getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload });
  });
}

let bootstrapPromise: Promise<void> | null = null;

// Exécute le bootstrap + les migrations une seule fois (singleton), peu
// importe le nombre d'appels à createDatabase()/exportDatabaseFile().
function ensureBootstrapped(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      for (const statement of BOOTSTRAP_SQL) {
        await callWorker("exec", { sql: statement });
      }

      // Pas de runner de migration versionné dans ce projet (voir le
      // commentaire en tête de bootstrap-sql.ts) — colonnes ajoutées après le
      // premier lancement gérées ici, une par une, en avalant l'erreur si la
      // colonne existe déjà.
      for (const statement of MIGRATION_SQL) {
        try {
          await callWorker("exec", { sql: statement });
        } catch {
          // colonne déjà présente (installation existante) — ignoré.
        }
      }
    })();
  }
  return bootstrapPromise;
}

export const MIGRATION_SQL: string[] = [
  "ALTER TABLE business_settings ADD COLUMN google_drive_client_id TEXT",
  "ALTER TABLE business_settings ADD COLUMN logo_data_url TEXT",
  "ALTER TABLE business_settings ADD COLUMN address TEXT",
  "ALTER TABLE business_settings ADD COLUMN phone TEXT",
  "ALTER TABLE business_settings ADD COLUMN email TEXT",
  "ALTER TABLE business_settings ADD COLUMN receipt_columns INTEGER NOT NULL DEFAULT 32",
  "ALTER TABLE business_settings ADD COLUMN enable_service_orders INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE business_settings ADD COLUMN print_promised_date_on_ticket INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE customer_credits ADD COLUMN service_order_id INTEGER REFERENCES service_orders(id)",
  "ALTER TABLE business_settings ADD COLUMN maintenance_code_hash TEXT",
  "ALTER TABLE business_settings ADD COLUMN enable_sales INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE business_settings ADD COLUMN enable_products INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE business_settings ADD COLUMN enable_stock INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE business_settings ADD COLUMN enable_suppliers INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE business_settings ADD COLUMN enable_purchases INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE business_settings ADD COLUMN modules_configured INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE users ADD COLUMN username TEXT",
  "ALTER TABLE business_settings ADD COLUMN whatsapp_country_code TEXT",
  "ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN locked_until TEXT",
  "ALTER TABLE business_settings ADD COLUMN auto_lock_minutes INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE business_settings ADD COLUMN tax_enabled INTEGER NOT NULL DEFAULT 0",
  // Multi-boutique : une boutique par défaut existe toujours, même
  // désactivé (voir stores.ts) — créée ici avant les backfills ci-dessous,
  // qui en ont besoin pour rattacher les lignes déjà existantes.
  "INSERT INTO stores (name, is_active) SELECT 'Boutique principale', 1 WHERE NOT EXISTS (SELECT 1 FROM stores)",
  "ALTER TABLE stock_locations ADD COLUMN store_id INTEGER REFERENCES stores(id)",
  "UPDATE stock_locations SET store_id = (SELECT id FROM stores ORDER BY id LIMIT 1) WHERE store_id IS NULL",
  "ALTER TABLE sales ADD COLUMN store_id INTEGER REFERENCES stores(id)",
  "UPDATE sales SET store_id = (SELECT id FROM stores ORDER BY id LIMIT 1) WHERE store_id IS NULL",
  "ALTER TABLE cash_sessions ADD COLUMN store_id INTEGER REFERENCES stores(id)",
  "UPDATE cash_sessions SET store_id = (SELECT id FROM stores ORDER BY id LIMIT 1) WHERE store_id IS NULL",
  "ALTER TABLE payments ADD COLUMN store_id INTEGER REFERENCES stores(id)",
  "ALTER TABLE business_settings ADD COLUMN multi_store_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN store_id INTEGER REFERENCES stores(id)",
  // Indépendance totale des boutiques : achats, dettes fournisseurs, créances
  // clients, dépenses, devis et tickets de service sont eux aussi rattachés à
  // une boutique — rétro-remplis vers la boutique par défaut pour les lignes
  // déjà existantes, exactement comme stock_locations/sales plus haut.
  "ALTER TABLE purchases ADD COLUMN store_id INTEGER REFERENCES stores(id)",
  "UPDATE purchases SET store_id = (SELECT id FROM stores ORDER BY id LIMIT 1) WHERE store_id IS NULL",
  "ALTER TABLE supplier_debts ADD COLUMN store_id INTEGER REFERENCES stores(id)",
  "UPDATE supplier_debts SET store_id = (SELECT id FROM stores ORDER BY id LIMIT 1) WHERE store_id IS NULL",
  "ALTER TABLE customer_credits ADD COLUMN store_id INTEGER REFERENCES stores(id)",
  "UPDATE customer_credits SET store_id = (SELECT id FROM stores ORDER BY id LIMIT 1) WHERE store_id IS NULL",
  "ALTER TABLE expenses ADD COLUMN store_id INTEGER REFERENCES stores(id)",
  "UPDATE expenses SET store_id = (SELECT id FROM stores ORDER BY id LIMIT 1) WHERE store_id IS NULL",
  "ALTER TABLE quotes ADD COLUMN store_id INTEGER REFERENCES stores(id)",
  "UPDATE quotes SET store_id = (SELECT id FROM stores ORDER BY id LIMIT 1) WHERE store_id IS NULL",
  "ALTER TABLE service_orders ADD COLUMN store_id INTEGER REFERENCES stores(id)",
  "UPDATE service_orders SET store_id = (SELECT id FROM stores ORDER BY id LIMIT 1) WHERE store_id IS NULL",
  // Paliers de fidélité : le cumul à vie est rétro-rempli depuis l'historique
  // des transactions de type "purchase" (jamais "redemption", qui ne doit
  // pas faire redescendre un palier déjà acquis) — précis, pas approximatif.
  "ALTER TABLE customers ADD COLUMN lifetime_loyalty_points REAL NOT NULL DEFAULT 0",
  `UPDATE customers SET lifetime_loyalty_points = COALESCE((SELECT SUM(points_delta) FROM loyalty_transactions WHERE loyalty_transactions.customer_id = customers.id AND reason = 'purchase'), 0) WHERE lifetime_loyalty_points = 0`,
  "ALTER TABLE business_settings ADD COLUMN loyalty_tier_silver_threshold REAL NOT NULL DEFAULT 5000",
  "ALTER TABLE business_settings ADD COLUMN loyalty_tier_gold_threshold REAL NOT NULL DEFAULT 20000",
  "ALTER TABLE business_settings ADD COLUMN loyalty_tier_silver_multiplier REAL NOT NULL DEFAULT 1.25",
  "ALTER TABLE business_settings ADD COLUMN loyalty_tier_gold_multiplier REAL NOT NULL DEFAULT 1.5",
];

export type Database = SqliteRemoteDatabase<typeof schema>;

export async function createDatabase(_filename = "gestion-boutique.sqlite3"): Promise<Database> {
  await ensureBootstrapped();

  return drizzle(async (sql, params, method) => {
    const response = await callWorker("exec", { sql, bind: params });
    const rows: unknown[][] = response.resultRows ?? [];

    if (method === "get") {
      // Doit rester `undefined` (pas `[]`) quand aucune ligne n'est trouvée,
      // sinon drizzle mappe un tableau vide en objet aux champs undefined
      // au lieu de renvoyer `undefined` pour .get(). Le type `AsyncRemoteCallback`
      // ne l'exprime pas, d'où le cast.
      return { rows: rows[0] as unknown[] };
    }
    return { rows };
  }, { schema });
}

// Exporte le fichier SQLite complet (bytes bruts) depuis OPFS — réutilise le
// même worker singleton que createDatabase().
export async function exportDatabaseFile(
  filename = "gestion-boutique.sqlite3",
): Promise<{ bytes: Uint8Array; filename: string }> {
  await ensureBootstrapped();
  const response = await callWorker("export");
  return { bytes: response.bytes as Uint8Array, filename };
}

// Remplace intégralement le contenu de la base OPFS par les octets fournis
// (ex : restauration d'une sauvegarde). Le worker ferme sa connexion interne
// avant d'écrire — après l'appel, il faut recharger la page pour repartir
// d'une connexion propre (createDatabase() rouvrirait sinon un état déjà
// périmé côté drizzle-orm).
export async function importDatabaseFile(bytes: Uint8Array): Promise<void> {
  await ensureBootstrapped();
  await callWorker("import", { bytes });
}
