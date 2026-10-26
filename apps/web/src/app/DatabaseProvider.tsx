import { createDatabase, type Database } from "@gestion-boutique/database";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

const DatabaseContext = createContext<Database | null>(null);

export function DatabaseProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
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
      <div role="alert" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12, maxWidth: 560 }}>
        <span style={{ color: "var(--color-danger)" }}>{t("database.initError", { error })}</span>
        <span style={{ color: "var(--color-text-muted)" }}>{t("database.initErrorHint")}</span>
        <div>
          <button onClick={() => window.location.reload()}>{t("database.reload")}</button>
        </div>
      </div>
    );
  }

  if (!db) {
    return <div style={{ padding: 24 }}>{t("database.initializing")}</div>;
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
