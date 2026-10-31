import { WsMessageTypes, type WsMessageType } from "./wsMessageTypes";

export class WsMessageFormatException extends Error {
  constructor(
    message: string,
    public readonly rawInput?: string,
  ) {
    super(message);
    this.name = "WsMessageFormatException";
  }
}

interface WsMessageInit {
  type: WsMessageType;
  payload?: Record<string, unknown>;
  correlationId?: string;
  timestamp?: Date;
}

// Enveloppe de message du protocole Master/Worker (mode réseau local).
//
// Format volontairement minimal et stable pour rester extensible sans
// rupture : `type` distingue le message, `payload` porte les données propres
// au type, `correlationId` relie une réponse (ex. error) à la requête qui
// l'a déclenchée, `timestamp` horodate l'émission.
export class WsMessage {
  readonly type: WsMessageType;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
  readonly timestamp: Date;

  constructor(init: WsMessageInit) {
    this.type = init.type;
    this.payload = init.payload ?? {};
    this.correlationId = init.correlationId ?? crypto.randomUUID();
    this.timestamp = init.timestamp ?? new Date();
  }

  toJson(): Record<string, unknown> {
    return {
      type: this.type,
      payload: this.payload,
      correlationId: this.correlationId,
      timestamp: this.timestamp.toISOString(),
    };
  }

  /** Sérialise l'enveloppe en une trame texte prête à être envoyée sur le WebSocket. */
  encode(): string {
    return JSON.stringify(this.toJson());
  }

  static fromJson(json: unknown): WsMessage {
    if (typeof json !== "object" || json === null) {
      throw new WsMessageFormatException("le message doit être un objet JSON");
    }
    const obj = json as Record<string, unknown>;

    const type = obj.type;
    if (typeof type !== "string" || type.length === 0) {
      throw new WsMessageFormatException('champ "type" manquant ou invalide');
    }

    const rawPayload = obj.payload;
    if (rawPayload != null && (typeof rawPayload !== "object" || Array.isArray(rawPayload))) {
      throw new WsMessageFormatException('champ "payload" doit être un objet JSON');
    }

    const rawCorrelationId = obj.correlationId;
    if (rawCorrelationId != null && typeof rawCorrelationId !== "string") {
      throw new WsMessageFormatException('champ "correlationId" doit être une chaîne');
    }

    let timestamp: Date | undefined;
    const rawTimestamp = obj.timestamp;
    if (typeof rawTimestamp === "string") {
      const parsed = new Date(rawTimestamp);
      if (Number.isNaN(parsed.getTime())) {
        throw new WsMessageFormatException('champ "timestamp" n\'est pas une date ISO-8601 valide');
      }
      timestamp = parsed;
    }

    return new WsMessage({
      type,
      payload: (rawPayload as Record<string, unknown> | undefined) ?? undefined,
      correlationId: rawCorrelationId as string | undefined,
      timestamp,
    });
  }

  /**
   * Décode une trame texte reçue sur le WebSocket. Lève
   * WsMessageFormatException si `raw` n'est pas un JSON valide ou ne
   * respecte pas l'enveloppe attendue — ne doit jamais faire planter la
   * connexion appelante (le serveur/client capture cette exception et
   * répond WsMessageTypes.error plutôt que de fermer le socket).
   */
  static decode(raw: string): WsMessage {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (e) {
      throw new WsMessageFormatException(
        `JSON invalide : ${e instanceof Error ? e.message : String(e)}`,
        raw,
      );
    }
    try {
      return WsMessage.fromJson(decoded);
    } catch (e) {
      if (e instanceof WsMessageFormatException) {
        throw new WsMessageFormatException(e.message, raw);
      }
      throw e;
    }
  }

  /**
   * Construit une réponse "error" référençant ce message via
   * correlationId — pratique côté serveur/client pour signaler un message
   * reçu invalide ou refusé.
   */
  errorReply(code: string, message: string): WsMessage {
    return new WsMessage({
      type: WsMessageTypes.error,
      payload: { code, message },
      correlationId: this.correlationId,
    });
  }
}
