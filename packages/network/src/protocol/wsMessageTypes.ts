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
  /** Demande du Worker, une seule fois à sa toute première connexion (aucun `lastSyncSeq` connu). */
  snapshotRequest: "snapshotRequest",
  /** Réponse du Master à `snapshotRequest` — porte un `CatalogSnapshot`. */
  snapshotResponse: "snapshotResponse",
} as const;

export type WsMessageType = (typeof WsMessageTypes)[keyof typeof WsMessageTypes] | (string & {});
