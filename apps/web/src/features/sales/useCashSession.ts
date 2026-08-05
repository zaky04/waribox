import {
  closeSession,
  getActiveSession,
  openSession,
  type CloseSessionInput,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useDatabase } from "../../app/DatabaseProvider";
import { useAuth } from "../auth/useAuth";

type CashSession = typeof schema.cashSessions.$inferSelect;

export function useCashSession(storeId: number | null) {
  const db = useDatabase();
  const { user } = useAuth();
  const [session, setSession] = useState<CashSession | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!user || !storeId) return;
    const active = await getActiveSession(db, user.id, storeId);
    setSession(active ?? null);
  }, [db, user, storeId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const open = async (openingAmount: number) => {
    if (!user || !storeId) return;
    const created = await openSession(db, { userId: user.id, storeId, openingAmount });
    setSession(created);
  };

  const close = async (input: Omit<CloseSessionInput, "sessionId">) => {
    if (!session) return;
    await closeSession(db, { ...input, sessionId: session.id });
    setSession(null);
  };

  return { session, open, close };
}
