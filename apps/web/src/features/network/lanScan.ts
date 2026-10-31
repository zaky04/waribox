import { WsMessage, WsMessageTypes } from "@gestion-boutique/network";

// Balayage réseau — voir CLAUDE.md, mode réseau Phase 1b. Pur JS/DOM, aucune
// dépendance native : fonctionne identiquement sur PWA, Tauri desktop et
// Tauri Android. Sert uniquement à retrouver l'adresse IP d'un Master déjà
// apparié dont l'IP a changé — jamais à découvrir un Master pour un premier
// appairage (le jeton reste requis, seul un scan de QR peut le fournir).

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Détecte l'adresse IPv4 locale de cet appareil via la technique standard
 * des candidats ICE WebRTC (aucun serveur STUN/réseau nécessaire — les
 * candidats "host" sont générés localement). Renvoie `null` si indisponible
 * (navigateur qui masque ces candidats, ex. Firefox depuis 2021) plutôt que
 * de lever — c'est alors simplement une absence de suggestion, pas une erreur.
 */
export function detectLocalIPv4(timeoutMs = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof RTCPeerConnection === "undefined") {
      resolve(null);
      return;
    }

    let settled = false;
    const pc = new RTCPeerConnection({ iceServers: [] });

    const finish = (ip: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pc.close();
      resolve(ip);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    pc.onicecandidate = (event) => {
      const candidate = event.candidate?.candidate;
      if (!candidate) return;
      const match = /candidate:\d+ \d+ (?:udp|tcp) \d+ (\d{1,3}(?:\.\d{1,3}){3}) /i.exec(candidate);
      const ip = match?.[1];
      if (ip && isPrivateIPv4(ip)) finish(ip);
    };

    pc.createDataChannel("waribox-discovery");
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => finish(null));
  });
}

/**
 * Sonde une adresse précise avec le jeton déjà connu (celui d'un appairage
 * précédent) — ouvre un WebSocket jetable, indépendant de tout état React,
 * pour ne pas perturber `useWorkerConnection` pendant un balayage de
 * centaines d'adresses. Résout `true` seulement si le Master y répond
 * vraiment (helloAck accepté), jamais sur la seule ouverture du socket.
 */
export function probeHost(
  host: string,
  port: number,
  token: string,
  deviceId: string,
  deviceName: string,
  timeoutMs = 1000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: WebSocket;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // déjà fermé/jamais ouvert
      }
      resolve(ok);
    };

    try {
      socket = new WebSocket(`ws://${host}:${port}`);
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => finish(false), timeoutMs);

    socket.onopen = () => {
      socket.send(
        new WsMessage({
          type: WsMessageTypes.hello,
          payload: { deviceId, deviceName, role: "worker", protocolVersion: 1, token },
        }).encode(),
      );
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = WsMessage.decode(event.data);
        finish(message.type === WsMessageTypes.helloAck && message.payload.accepted === true);
      } catch {
        finish(false);
      }
    };

    socket.onerror = () => finish(false);
    socket.onclose = () => finish(false);
  });
}

interface KnownMaster {
  port: number;
  token: string;
}

/**
 * Balaie le sous-réseau /24 de cet appareil à la recherche du Master déjà
 * apparié (`known`), par lots pour limiter la concurrence. Renvoie l'adresse
 * qui répond correctement, ou `null` si rien n'est trouvé / le sous-réseau
 * local n'a pas pu être détecté. `isCancelled` permet d'abandonner tôt (ex.
 * un autre mécanisme, mDNS, a déjà trouvé le Master en parallèle).
 */
export async function scanForMaster(
  known: KnownMaster,
  deviceId: string,
  deviceName: string,
  isCancelled: () => boolean,
): Promise<string | null> {
  const localIp = await detectLocalIPv4();
  if (!localIp || isCancelled()) return null;

  const prefix = localIp.split(".").slice(0, 3).join(".");
  const candidates: string[] = [];
  for (let i = 1; i <= 254; i++) {
    const host = `${prefix}.${i}`;
    if (host !== localIp) candidates.push(host);
  }

  const CONCURRENCY = 24;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    if (isCancelled()) return null;
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((host) => probeHost(host, known.port, known.token, deviceId, deviceName)),
    );
    const foundIndex = results.findIndex(Boolean);
    if (foundIndex !== -1) return batch[foundIndex] ?? null;
  }
  return null;
}
