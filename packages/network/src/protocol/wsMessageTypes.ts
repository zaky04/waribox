// Types de message connus du protocole WebSocket Master/Worker du mode
// réseau local. Liste de constantes (pas un union type strict) plutôt qu'un
// enum : WsMessage.type reste une string brute, pour qu'un message d'un type
// inconnu (ex. envoyé par une version plus récente de l'app) reste
// décodable — c'est à l'appelant de décider de l'ignorer ou de répondre
// "error", pas au décodage lui-même d'échouer.
//
// Le premier jeu de types (hello/helloAck/ping/pong/error/disconnect) ne
// couvrait que la poignée de main (Phase 1) — le mode réseau Phase 2 ajoute
// les types nécessaires à la réplication des ventes/stock/dépenses : voir
// CLAUDE.md, section mode réseau.
export const WsMessageTypes = {
  /** Envoyé par le Worker à la connexion, avec le jeton de pairage. */
  hello: "hello",
  /** Réponse du Master à hello (accepté ou refusé). */
  helloAck: "helloAck",
  /** Sonde de liveness, dans les deux sens. */
  ping: "ping",
  /** Réponse à ping. */
  pong: "pong",
  /** Signale une erreur de traitement d'un message précédent. */
  error: "error",
  /** Fermeture propre annoncée avant la déconnexion. */
  disconnect: "disconnect",
  /**
   * Porte un `SyncEvent` (voir @gestion-boutique/core) — dans les deux sens :
   * Worker → Master à l'émission ou au rattrapage de la file d'attente
   * locale, Master → Worker à la diffusion en direct ou au rattrapage
   * (`__sync_log` postérieur au `lastSyncSeq` annoncé dans `hello`).
   */
  sync: "sync",
  /** Accusé de réception d'un `sync` — référence son correlationId. */
  syncAck: "syncAck",
  /**
   * Worker → Maître : demande l'état à jour (catalogue + soldes de stock). Porte les empreintes des
   * tables déjà reçues (`knownHashes`) pour ne recevoir que ce qui a changé. Envoyé à la connexion,
   * périodiquement, et à la réception d'un `catalogChanged`.
   */
  snapshotRequest: "snapshotRequest",
  /** Maître → Worker : réponse à `snapshotRequest` (ou instantané complet au premier appairage) — porte un `CatalogSnapshot`. */
  snapshotResponse: "snapshotResponse",
  /** Maître → Worker : le catalogue a changé, redemande l'état dès que tu es au calme. */
  catalogChanged: "catalogChanged",
  /**
   * Le Maître refuse un `sync` (validation échouée) — référence son correlationId.
   * Sans ce message, l'appareil relié renvoyait indéfiniment un événement que
   * le Maître n'acceptera jamais, sans en être informé.
   */
  syncRejected: "syncRejected",
  /** Worker → Maître : demande d'un défi pour vérifier le PIN d'un responsable (voir pinProof.ts). */
  pinChallenge: "pinChallenge",
  pinChallengeResult: "pinChallengeResult",
  /** Worker → Maître : preuve de PIN pour une approbation immédiate. */
  pinVerify: "pinVerify",
  pinVerifyResult: "pinVerifyResult",
  /** Worker → Maître : décision sur une demande d'approbation, avec preuve de PIN. */
  approvalDecision: "approvalDecision",
  approvalDecisionResult: "approvalDecisionResult",
} as const;

export type WsMessageType = (typeof WsMessageTypes)[keyof typeof WsMessageTypes] | (string & {});
