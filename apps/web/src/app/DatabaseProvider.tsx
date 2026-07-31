import { createDatabase, type Database } from "@gestion-boutique/database";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const DatabaseContext = createContext<Database | null>(null);

export function DatabaseProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<Database | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    createDatabase()
      .then((instance) => {
        if (!cancelled) setDb(instance);
      })
      .catch((err) => {
        console.error("Échec d'initialisation de la base locale", err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div style={{ padding: 24, color: "#f87171" }}>
        Impossible d'initialiser la base de données locale : {error}
      </div>
    );
  }

  if (!db) {
    return <div style={{ padding: 24 }}>Initialisation de la base locale...</div>;
  }

  return <DatabaseContext.Provider value={db}>{children}</DatabaseContext.Provider>;
}

export function useDatabase(): Database {
  const db = useContext(DatabaseContext);
  if (!db) {
    throw new Error("useDatabase() doit être utilisé à l'intérieur de <DatabaseProvider>");
  }
  return db;
}
