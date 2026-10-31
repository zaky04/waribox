// Autorisations d'approbation à usage unique.
//
// Un appareil relié qui veut faire une action au-dessus d'un seuil (dépense, retrait
// de stock, remise hors promotion, vente à crédit) fait d'abord vérifier le PIN
// d'approbation d'un responsable PAR LE MAÎTRE (défi/réponse, voir pinProof.ts). Quand
// la preuve est bonne, le Maître délivre une autorisation (`grantId`) liée à ce
// responsable et à cet appareil. L'événement que l'appareil envoie ensuite la
// présente : sans elle, un appareil qui connaît seulement le jeton de pairage pourrait
// affirmer « approuvé par le propriétaire » sans que personne n'ait rien approuvé.
//
// Une autorisation vaut 5 minutes et ne sert qu'une fois ; elle n'étend pas les
// droits du responsable (le Maître revérifie son droit d'approuver ce domaine et son
// plafond au moment de l'événement). Elle vit en mémoire : un redémarrage la perd,
// ce qui est voulu.

export const APPROVAL_GRANT_TTL_MS = 5 * 60_000;
const MAX_GRANTS = 500;

// ---- Côté Maître ----

export function createGrantStore() {
  const grants = new Map<string, { approverId: number; deviceId: string; expiresAt: number }>();
  const purge = (now: number) => {
    for (const [id, g] of grants) if (g.expiresAt <= now) grants.delete(id);
  };
  return {
    issue(approverId: number, deviceId: string, now = Date.now()): string {
      purge(now);
      if (grants.size >= MAX_GRANTS) {
        // Plus ancienne d'abord : un appareil qui en demande sans cesse ne doit pas évincer les autres indéfiniment.
        const oldest = grants.keys().next().value;
        if (oldest !== undefined) grants.delete(oldest);
      }
      const id = crypto.randomUUID();
      grants.set(id, { approverId, deviceId, expiresAt: now + APPROVAL_GRANT_TTL_MS });
      return id;
    },
    /** Valable pour CE responsable et CET appareil ? (ne consomme pas) */
    check(grantId: string | undefined, approverId: number | null | undefined, deviceId: string, now = Date.now()): boolean {
      if (!grantId || approverId == null) return false;
      const g = grants.get(grantId);
      return !!g && g.expiresAt > now && g.approverId === approverId && g.deviceId === deviceId;
    },
    consume(grantId: string): void {
      grants.delete(grantId);
    },
    size: () => grants.size,
  };
}

export type GrantStore = ReturnType<typeof createGrantStore>;

// ---- Côté appareil relié ----

const received = new Map<number, { grantId: string; expiresAt: number }>();

/** Mémorise l'autorisation reçue du Maître pour ce responsable (la plus récente remplace l'ancienne). */
export function rememberApprovalGrant(approverId: number, grantId: string, now = Date.now()): void {
  received.set(approverId, { grantId, expiresAt: now + APPROVAL_GRANT_TTL_MS });
}

/** Reprend (et oublie) l'autorisation de ce responsable, si elle est encore valable. */
export function takeApprovalGrant(approverId: number, now = Date.now()): string | undefined {
  const g = received.get(approverId);
  received.delete(approverId);
  return g && g.expiresAt > now ? g.grantId : undefined;
}

/** Ajoute à un événement créé localement l'autorisation du responsable qui l'a approuvé. */
export function attachApprovalGrant<T extends { approverId?: number | null; grantId?: string }>(event: T): T {
  if (event.approverId == null || event.grantId) return event;
  const grantId = takeApprovalGrant(event.approverId);
  return grantId ? { ...event, grantId } : event;
}

export function clearReceivedApprovalGrants(): void {
  received.clear();
}
