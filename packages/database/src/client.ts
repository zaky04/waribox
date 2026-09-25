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

      // Legacy Phase 0, gelé — ne plus jamais ajouter d'entrée ici (voir
      // MIGRATIONS ci-dessous pour toute nouvelle évolution de schéma).
      // Conservé tel quel, avec son avalage d'erreur, car on ne sait pas si
      // une base déjà déployée avant l'introduction de `__migrations` a déjà
      // ces colonnes ou non — sans ce filet, une installation existante
      // planterait ici sur "duplicate column".
      for (const statement of MIGRATION_SQL) {
        try {
          await callWorker("exec", { sql: statement });
        } catch {
          // colonne déjà présente (installation existante) — ignoré.
        }
      }

      await runMigrations();
    })();
  }
  return bootstrapPromise;
}

// Phase 1 : chaque migration ne s'exécute qu'une seule fois (suivie dans
// `__migrations`, créée par BOOTSTRAP_SQL), dans sa propre transaction, sans
// avaler d'erreur — contrairement à MIGRATION_SQL ci-dessus, une vraie erreur
// (faute de frappe SQL, contrainte violée...) remonte et bloque le
// démarrage au lieu d'être silencieusement ignorée. Toute nouvelle évolution
// de schéma doit être ajoutée ICI, jamais dans MIGRATION_SQL.
export interface Migration {
  id: number;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    statements: ["ALTER TABLE stock_batches ADD COLUMN unit_cost REAL"],
  },
  {
    id: 2,
    statements: [
      "ALTER TABLE business_settings ADD COLUMN maintenance_code_failed_attempts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE business_settings ADD COLUMN maintenance_code_locked_until TEXT",
    ],
  },
  // Mode réseau Phase 2 (voir CLAUDE.md) : `sync_id` identifie une ligne
  // indépendamment de l'id local auto-incrémenté (propre à chaque appareil,
  // sans rapport entre eux) — c'est lui qui circule dans les événements de
  // réplication entre Master et Workers. Index unique partiel (WHERE sync_id
  // IS NOT NULL) : les lignes déjà existantes avant cette migration restent
  // à NULL, jamais concernées par la contrainte d'unicité. `__sync_log`/
  // `__sync_outbox`/`__sync_state` : voir packages/database/src/schema/sync.ts.
  {
    id: 3,
    statements: [
      "ALTER TABLE sales ADD COLUMN sync_id TEXT",
      "CREATE UNIQUE INDEX idx_sales_sync_id ON sales(sync_id) WHERE sync_id IS NOT NULL",
      "ALTER TABLE sale_items ADD COLUMN sync_id TEXT",
      "CREATE UNIQUE INDEX idx_sale_items_sync_id ON sale_items(sync_id) WHERE sync_id IS NOT NULL",
      "ALTER TABLE payments ADD COLUMN sync_id TEXT",
      "CREATE UNIQUE INDEX idx_payments_sync_id ON payments(sync_id) WHERE sync_id IS NOT NULL",
      "ALTER TABLE stock_movements ADD COLUMN sync_id TEXT",
      "CREATE UNIQUE INDEX idx_stock_movements_sync_id ON stock_movements(sync_id) WHERE sync_id IS NOT NULL",
      "ALTER TABLE stock_batches ADD COLUMN sync_id TEXT",
      "CREATE UNIQUE INDEX idx_stock_batches_sync_id ON stock_batches(sync_id) WHERE sync_id IS NOT NULL",
      "ALTER TABLE customer_credits ADD COLUMN sync_id TEXT",
      "CREATE UNIQUE INDEX idx_customer_credits_sync_id ON customer_credits(sync_id) WHERE sync_id IS NOT NULL",
      "ALTER TABLE loyalty_transactions ADD COLUMN sync_id TEXT",
      "CREATE UNIQUE INDEX idx_loyalty_transactions_sync_id ON loyalty_transactions(sync_id) WHERE sync_id IS NOT NULL",
      "ALTER TABLE customers ADD COLUMN sync_id TEXT",
      "CREATE UNIQUE INDEX idx_customers_sync_id ON customers(sync_id) WHERE sync_id IS NOT NULL",
      "ALTER TABLE expenses ADD COLUMN sync_id TEXT",
      "CREATE UNIQUE INDEX idx_expenses_sync_id ON expenses(sync_id) WHERE sync_id IS NOT NULL",
      `CREATE TABLE __sync_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        origin_device_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE __sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_at TEXT
      )`,
      `CREATE TABLE __sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    ],
  },
  // FNE (Facture Normalisée Électronique, Côte d'Ivoire) — voir CLAUDE.md.
  // Coquille de colonnes/table, désactivée par défaut (fne_enabled = 0) —
  // aucun effet tant que le commerçant n'a pas saisi une vraie clé API dans
  // Paramètres.
  {
    id: 4,
    statements: [
      "ALTER TABLE business_settings ADD COLUMN fne_enabled INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE business_settings ADD COLUMN fne_environment TEXT NOT NULL DEFAULT 'test'",
      "ALTER TABLE business_settings ADD COLUMN fne_api_key TEXT",
      "ALTER TABLE business_settings ADD COLUMN fne_api_base_url TEXT",
      "ALTER TABLE business_settings ADD COLUMN fne_establishment TEXT",
      "ALTER TABLE business_settings ADD COLUMN fne_point_of_sale TEXT",
      "ALTER TABLE sales ADD COLUMN fne_status TEXT",
      "ALTER TABLE sales ADD COLUMN fne_reference TEXT",
      "ALTER TABLE sales ADD COLUMN fne_ncc TEXT",
      "ALTER TABLE sales ADD COLUMN fne_qr_token TEXT",
      "ALTER TABLE sales ADD COLUMN fne_balance_sticker INTEGER",
      "ALTER TABLE sales ADD COLUMN fne_error TEXT",
      "ALTER TABLE sales ADD COLUMN fne_certified_at TEXT",
      `CREATE TABLE __fne_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ],
  },
  // Apparence (voir Paramètres → Apparence, CLAUDE.md journal du 2026-09-20)
  // — couleur d'accent et forme des coins personnalisables, indépendantes du
  // secteur d'activité (qui ne pilote plus que l'icône/libellé "Produits").
  {
    id: 5,
    statements: [
      "ALTER TABLE business_settings ADD COLUMN appearance_accent_color TEXT",
      "ALTER TABLE business_settings ADD COLUMN appearance_shape TEXT",
    ],
  },
  // Fond de page et police d'interface personnalisables (Paramètres → Apparence).
  {
    id: 6,
    statements: [
      "ALTER TABLE business_settings ADD COLUMN appearance_background TEXT",
      "ALTER TABLE business_settings ADD COLUMN appearance_font TEXT",
    ],
  },
  // Contrôles de gestion (approbations, inventaire, chaîne d'audit, achats en
  // deux temps, plafonds de crédit...) — voir CLAUDE.md, journal du 2026-09-25.
  // Tous les seuils sont NULL/0 par défaut : aucun comportement ne change tant
  // que le propriétaire n'active pas un contrôle.
  {
    id: 7,
    statements: [
      "ALTER TABLE business_settings ADD COLUMN approval_refund_threshold REAL",
      "ALTER TABLE business_settings ADD COLUMN approval_stock_threshold REAL",
      "ALTER TABLE business_settings ADD COLUMN approval_credit_threshold REAL",
      "ALTER TABLE business_settings ADD COLUMN cash_variance_threshold REAL",
      "ALTER TABLE business_settings ADD COLUMN price_alert_percent REAL NOT NULL DEFAULT 10",
      "ALTER TABLE business_settings ADD COLUMN require_purchase_receipt INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE business_settings ADD COLUMN default_credit_limit REAL",
      "ALTER TABLE users ADD COLUMN limit_refund REAL",
      "ALTER TABLE users ADD COLUMN limit_stock REAL",
      "ALTER TABLE users ADD COLUMN limit_credit REAL",
      "ALTER TABLE audit_log ADD COLUMN prev_hash TEXT",
      "ALTER TABLE audit_log ADD COLUMN hash TEXT",
      "ALTER TABLE customers ADD COLUMN credit_limit REAL",
      "ALTER TABLE customer_credits ADD COLUMN approved_by INTEGER",
      "ALTER TABLE credit_repayments ADD COLUMN received_by INTEGER",
      "ALTER TABLE credit_repayments ADD COLUMN store_id INTEGER",
      "ALTER TABLE refunds ADD COLUMN approved_by INTEGER",
      "ALTER TABLE purchases ADD COLUMN invoice_reference TEXT",
      "ALTER TABLE purchases ADD COLUMN received_at TEXT",
      "ALTER TABLE purchases ADD COLUMN received_by INTEGER",
      "ALTER TABLE purchase_items ADD COLUMN received_quantity REAL",
      "ALTER TABLE purchase_items ADD COLUMN previous_unit_cost REAL",
      "ALTER TABLE purchase_items ADD COLUMN price_alert INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE supplier_debt_payments ADD COLUMN paid_by INTEGER",
      "ALTER TABLE stock_movements ADD COLUMN note TEXT",
      "ALTER TABLE stock_movements ADD COLUMN approved_by INTEGER",
      `CREATE TABLE stock_counts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id INTEGER,
        location_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        started_by INTEGER NOT NULL,
        closed_by INTEGER,
        approved_by INTEGER,
        note TEXT,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at TEXT
      )`,
      `CREATE TABLE stock_count_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        count_id INTEGER NOT NULL,
        variant_id INTEGER NOT NULL,
        system_quantity REAL NOT NULL,
        counted_quantity REAL,
        unit_cost REAL
      )`,
    ],
  },
  // Droits particuliers par utilisateur (par-dessus le rôle).
  {
    id: 8,
    statements: ["ALTER TABLE users ADD COLUMN permission_overrides TEXT"],
  },
];

async function runMigrations(): Promise<void> {
  const appliedResponse = await callWorker("exec", { sql: "SELECT id FROM __migrations" });
  const applied = new Set((appliedResponse.resultRows ?? []).map((row) => Number(row[0])));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    await callWorker("exec", { sql: "BEGIN IMMEDIATE" });
    try {
      for (const statement of migration.statements) {
        await callWorker("exec", { sql: statement });
      }
      await callWorker("exec", { sql: "INSERT INTO __migrations (id) VALUES (?)", bind: [migration.id] });
      await callWorker("exec", { sql: "COMMIT" });
    } catch (err) {
      try {
        await callWorker("exec", { sql: "ROLLBACK" });
      } catch {
        // Connexion déjà dans un état anormal — l'erreur d'origine prime.
      }
      throw err;
    }
  }
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
  // Export SYSCOHADA : désactivé par défaut, numéros de compte modifiables
  // (voir le commentaire sur ces colonnes dans schema/settings.ts) puisque le
  // référentiel OHADA est révisé de temps à autre.
  "ALTER TABLE business_settings ADD COLUMN enable_syscohada INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE business_settings ADD COLUMN syscohada_account_clients TEXT NOT NULL DEFAULT '411'",
  "ALTER TABLE business_settings ADD COLUMN syscohada_account_fournisseurs TEXT NOT NULL DEFAULT '401'",
  "ALTER TABLE business_settings ADD COLUMN syscohada_account_tva_ventes TEXT NOT NULL DEFAULT '4431'",
  "ALTER TABLE business_settings ADD COLUMN syscohada_account_tva_services TEXT NOT NULL DEFAULT '4432'",
  "ALTER TABLE business_settings ADD COLUMN syscohada_account_tva_achats TEXT NOT NULL DEFAULT '4452'",
  "ALTER TABLE business_settings ADD COLUMN syscohada_account_banque TEXT NOT NULL DEFAULT '512'",
  "ALTER TABLE business_settings ADD COLUMN syscohada_account_caisse TEXT NOT NULL DEFAULT '571'",
  "ALTER TABLE business_settings ADD COLUMN syscohada_account_mobile_money TEXT NOT NULL DEFAULT '5715'",
  "ALTER TABLE business_settings ADD COLUMN syscohada_account_achats TEXT NOT NULL DEFAULT '601'",
  "ALTER TABLE business_settings ADD COLUMN syscohada_account_ventes TEXT NOT NULL DEFAULT '701'",
  "ALTER TABLE business_settings ADD COLUMN syscohada_account_services TEXT NOT NULL DEFAULT '706'",
  "ALTER TABLE business_settings ADD COLUMN syscohada_default_expense_account_code TEXT NOT NULL DEFAULT '628'",
  "ALTER TABLE business_settings ADD COLUMN syscohada_default_expense_account_label TEXT NOT NULL DEFAULT 'Autres charges externes'",
  "ALTER TABLE business_settings ADD COLUMN low_stock_alert_phone TEXT",
  // Comptes de charge par défaut, un par catégorie suggérée (EXPENSE_CATEGORIES)
  // — idempotent via UNIQUE(category) + OR IGNORE, donc sûr à rejouer à
  // chaque lancement, y compris sur une base déjà migrée.
  `INSERT OR IGNORE INTO syscohada_expense_accounts (category, account_code, account_label) VALUES
    ('Loyer', '613', 'Locations'),
    ('Salaires', '661', 'Rémunérations directes versées au personnel'),
    ('Électricité', '605', 'Autres achats (eau, électricité)'),
    ('Eau', '605', 'Autres achats (eau, électricité)'),
    ('Transport', '611', 'Transports'),
    ('Fournitures', '604', 'Achats stockés de fournitures'),
    ('Entretien', '615', 'Entretien, réparations et maintenance'),
    ('Assurance', '616', 'Primes d''assurance'),
    ('Impôts/Taxes', '641', 'Impôts et taxes directs'),
    ('Autre', '628', 'Autres charges externes')`,
  "ALTER TABLE business_settings ADD COLUMN enable_promotions INTEGER NOT NULL DEFAULT 0",
];

// Sérialise les transactions entre elles : une seule connexion SQLite
// partagée (voir getWorker ci-dessus), donc une transaction imbriquée dans
// une autre échouerait ("cannot start a transaction within a transaction").
// Ce verrou fait la queue plutôt que d'échouer.
let txLock: Promise<void> = Promise.resolve();

// Vraie atomicité malgré `drizzle-orm/sqlite-proxy` (qui n'a pas de support
// de transaction natif) : la connexion SQLite est unique et les messages du
// worker sont traités séquentiellement (voir sahpool-worker.js), donc BEGIN/
// COMMIT/ROLLBACK envoyés directement via callWorker encadrent correctement
// tous les appels drizzle passés dans `fn` — ceux-ci empruntent le même canal.
// `fn` doit englober toute la séquence lecture-validation-écriture d'une
// opération métier (pas seulement les écritures), sinon une deuxième
// opération pourrait s'intercaler entre la validation et l'écriture de la
// première (ex : double-vente de la dernière unité en stock).
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    await callWorker("exec", { sql: "BEGIN IMMEDIATE" });
    try {
      const result = await fn();
      await callWorker("exec", { sql: "COMMIT" });
      return result;
    } catch (err) {
      try {
        await callWorker("exec", { sql: "ROLLBACK" });
      } catch {
        // La connexion est déjà dans un état anormal (ex: worker perdu) —
        // l'erreur d'origine est plus utile au demandeur que celle-ci.
      }
      throw err;
    }
  };

  const scheduled = txLock.then(run, run);
  txLock = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
}

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
