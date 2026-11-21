// Worker SQLite dédié, copié tel quel (non bundlé par Vite/Rollup) dans
// apps/web/public/ — voir copySqliteWasmAssets() dans apps/web/vite.config.ts.
// Utilise le VFS OPFS SAH-pool (installOpfsSAHPoolVfs) plutôt que le VFS OPFS
// classique du Worker1/Promiser1 fourni par sqlite-wasm : ce dernier a besoin
// d'un second Worker imbriqué pour son proxy asynchrone (Atomics.wait), ce qui
// échoue sous le protocole interne de Tauri (WebView2) même si crossOriginIsolated
// est vrai. Le SAH-pool utilise l'accès synchrone direct (FileSystemSyncAccessHandle)
// dans ce seul worker — aucun worker imbriqué, donc pas ce problème.
import sqlite3InitModule from "./sqlite-wasm/index.mjs";

const DB_FILENAME = "/gestion-boutique.sqlite3";

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const sqlite3 = await sqlite3InitModule();
      const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: "gestion-boutique-vfs" });
      const db = new poolUtil.OpfsSAHPoolDb(DB_FILENAME);
      // SQLite n'applique PAS les clés étrangères par défaut : les ~40 `REFERENCES` du schéma n'étaient que
      // documentaires (une ligne pouvait pointer vers un parent inexistant). Activé à chaque ouverture — le
      // réglage est par connexion. Les tests du cœur tournent déjà avec les clés étrangères actives.
      db.exec("PRAGMA foreign_keys = ON");
      return { db, poolUtil, sqlite3 };
    })();
  }
  return dbPromise;
}

self.onmessage = async (event) => {
  const { id, type, sql, bind, bytes: importBytes } = event.data;
  try {
    const { db, poolUtil, sqlite3 } = await getDb();
    if (type === "exec") {
      const resultRows = db.exec({ sql, bind, rowMode: "array", returnValue: "resultRows" });
      self.postMessage({ id, resultRows });
    } else if (type === "export") {
      const bytes = poolUtil.exportFile(DB_FILENAME);
      self.postMessage({ id, bytes }, [bytes.buffer]);
    } else if (type === "import") {
      // Écrit directement les octets dans le fichier OPFS sous-jacent — la
      // connexion ouverte doit être fermée avant, sinon son état interne
      // (cache de pages) reste incohérent avec le contenu remplacé. On force
      // la réouverture au prochain message en vidant le cache du worker.
      db.close();
      poolUtil.importDb(DB_FILENAME, importBytes);
      dbPromise = null;
      self.postMessage({ id });
    } else if (type === "verify") {
      // Test de restauration : ouvre les octets reçus dans une base SÉPARÉE, en mémoire (la vraie base n'est pas
      // touchée), et la contrôle. Les tables essentielles sont comptées ; une table absente donne null.
      const probe = new sqlite3.oo1.DB(":memory:", "c");
      try {
        const pointer = sqlite3.wasm.allocFromTypedArray(importBytes);
        const rc = sqlite3.capi.sqlite3_deserialize(
          probe.pointer,
          "main",
          pointer,
          importBytes.length,
          importBytes.length,
          sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
        );
        probe.checkRc(rc);
        const integrity = String(probe.selectValue("PRAGMA integrity_check"));
        const counts = {};
        for (const table of ["users", "products", "sales", "business_settings", "customers", "stock_movements"]) {
          try {
            counts[table] = Number(probe.selectValue(`SELECT count(*) FROM ${table}`));
          } catch {
            counts[table] = null;
          }
        }
        self.postMessage({ id, probe: { integrity, counts } });
      } finally {
        probe.close();
      }
    } else {
      self.postMessage({ id, error: `Type de message inconnu : ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
};

self.postMessage({ type: "ready" });
