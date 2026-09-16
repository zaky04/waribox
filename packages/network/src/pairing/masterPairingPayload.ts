const FORMAT_VERSION = 1;

export interface MasterPairingPayloadInit {
  masterId: string;
  masterName: string;
  host: string;
  port: number;
  token: string;
}

/**
 * Contenu encodé dans le QR de pairage affiché par le Master — tout ce
 * qu'un Worker doit connaître pour s'y connecter directement : identité du
 * Master, adresse réseau, et le jeton de pairage qui protège la connexion
 * (voir CLAUDE.md, mode réseau : pas de TLS possible côté Worker JS/WebView,
 * donc sécurité assurée par ce jeton plutôt que par un certificat épinglé).
 *
 * Format volontairement plat et versionné (`v: 1`) plutôt qu'un objet
 * imbriqué, pour rester petit dans le QR.
 */
export class MasterPairingPayload {
  readonly masterId: string;
  readonly masterName: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;

  constructor(init: MasterPairingPayloadInit) {
    this.masterId = init.masterId;
    this.masterName = init.masterName;
    this.host = init.host;
    this.port = init.port;
    this.token = init.token;
  }

  /** Sérialise en JSON compact — c'est cette chaîne qui est encodée dans le QR. */
  encode(): string {
    return JSON.stringify({
      v: FORMAT_VERSION,
      masterId: this.masterId,
      masterName: this.masterName,
      host: this.host,
      port: this.port,
      token: this.token,
    });
  }

  /**
   * Décode le contenu brut scanné (ou saisi manuellement). Renvoie `null`
   * sur tout contenu invalide (pas du JSON, champ manquant, version de
   * format inconnue, port hors bornes) plutôt que de lever une exception —
   * un QR scanné peut être n'importe quoi (code-barres produit, URL...), ce
   * n'est jamais une erreur de programmation côté appelant.
   */
  static tryDecode(raw: string): MasterPairingPayload | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return null;
    }

    if (typeof decoded !== "object" || decoded === null) return null;
    const obj = decoded as Record<string, unknown>;

    if (obj.v !== FORMAT_VERSION) return null;

    const { masterId, masterName, host, port, token } = obj;
    if (typeof masterId !== "string" || masterId.length === 0) return null;
    if (typeof masterName !== "string" || masterName.length === 0) return null;
    if (typeof host !== "string" || host.length === 0) return null;
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (typeof token !== "string" || token.length === 0) return null;

    return new MasterPairingPayload({ masterId, masterName, host, port, token });
  }
}
