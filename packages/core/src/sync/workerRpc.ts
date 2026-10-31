import { WsMessage, WsMessageTypes } from "@gestion-boutique/network";
import { computePinProof, PIN_VERIFY_CONTEXT, pinDecisionContext, type PinChallenge } from "../auth/pinProof";
import type { PinKind } from "../auth/remotePin";
import { rememberApprovalGrant } from "./approvalGrants";

// Côté appareil relié : requêtes/réponses vers le Maître (vérifier un PIN,
// trancher une demande d'approbation). Sans réseau ni interface — la couche
// réseau fournit `send` (renvoie false si la connexion n'est pas ouverte) et
// passe chaque message reçu à `handle`. Le PIN saisi ne quitte jamais cet
// appareil : seule une preuve liée à un défi du Maître est envoyée.

export interface WorkerRpcOptions {
  send: (message: WsMessage) => boolean;
  timeoutMs?: number;
}

export function createWorkerRpc(options: WorkerRpcOptions) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pending = new Map<string, { resolve: (m: WsMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  function call(type: string, payload: Record<string, unknown>): Promise<WsMessage> {
    return new Promise((resolve, reject) => {
      const message = new WsMessage({ type, payload });
      const timer = setTimeout(() => {
        pending.delete(message.correlationId);
        reject(new Error("Le Maître n'a pas répondu."));
      }, timeoutMs);
      pending.set(message.correlationId, { resolve, reject, timer });
      if (!options.send(message)) {
        clearTimeout(timer);
        pending.delete(message.correlationId);
        reject(new Error("Pas de connexion au Maître."));
      }
    });
  }

  async function challenge(approverId: number, kind: PinKind): Promise<PinChallenge> {
    const reply = await call(WsMessageTypes.pinChallenge, { approverId, kind });
    if (reply.payload.ok !== true) throw new Error(String(reply.payload.error ?? "Défi refusé."));
    return reply.payload.challenge as PinChallenge;
  }

  return {
    /** À appeler pour chaque message reçu : renvoie vrai s'il répondait à une requête en attente. */
    handle(message: WsMessage): boolean {
      const entry = pending.get(message.correlationId);
      if (!entry) return false;
      pending.delete(message.correlationId);
      clearTimeout(entry.timer);
      entry.resolve(message);
      return true;
    },

    /** Connexion perdue : toutes les requêtes en attente échouent tout de suite. */
    rejectAll(reason: string): void {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
        pending.delete(id);
      }
    },

    /** Vérifie un PIN chez le Maître (utilisable comme RemotePinVerifier) : déverrouillage ou approbation. */
    async verifyPin(approverId: number, pin: string, kind: PinKind = "unlock"): Promise<boolean> {
      const ch = await challenge(approverId, kind);
      const proof = await computePinProof(pin, ch, PIN_VERIFY_CONTEXT);
      const reply = await call(WsMessageTypes.pinVerify, { approverId, nonce: ch.nonce, proof });
      if (reply.payload.error) throw new Error(String(reply.payload.error));
      // Autorisation délivrée par le Maître : jointe à l'action approuvée (voir attachApprovalGrant).
      if (reply.payload.ok === true && kind === "approval" && typeof reply.payload.grantId === "string") {
        rememberApprovalGrant(approverId, reply.payload.grantId);
      }
      return reply.payload.ok === true;
    },

    /** Tranche une demande d'approbation chez le Maître ; lève l'erreur du Maître en cas de refus. */
    async decide(input: { requestSyncId: string; approverId: number; pin: string; approve: boolean; note?: string }): Promise<void> {
      const ch = await challenge(input.approverId, "approval");
      const proof = await computePinProof(input.pin, ch, pinDecisionContext(input.requestSyncId, input.approve));
      const reply = await call(WsMessageTypes.approvalDecision, {
        requestSyncId: input.requestSyncId,
        approverId: input.approverId,
        approve: input.approve,
        note: input.note,
        nonce: ch.nonce,
        proof,
      });
      if (reply.payload.ok !== true) throw new Error(String(reply.payload.error ?? "Décision refusée."));
    },

    pendingCount: () => pending.size,
  };
}

export type WorkerRpc = ReturnType<typeof createWorkerRpc>;
