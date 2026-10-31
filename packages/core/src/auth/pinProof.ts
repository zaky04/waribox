import type { Database } from "@gestion-boutique/database";
import { schema } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import { eq } from "drizzle-orm";
import { argon2id, createHMAC, createSHA256 } from "hash-wasm";
import {
  clearFailedApprovalAttempts,
  clearFailedAttempts,
  registerFailedApprovalAttempt,
  registerFailedAttempt,
  remainingLockSeconds,
} from "./lockout";
import { isRemotePinHash } from "./pin";
import type { PinKind } from "./remotePin";

// Vérification à distance d'un code PIN, sans jamais le faire circuler :
//  1. l'appareil relié demande un défi pour un responsable (`issuePinChallenge`,
//     chez le Maître) : un nonce à usage unique + le sel et les paramètres Argon2
//     du hash enregistré (ils ne sont pas secrets) ;
//  2. l'appareil dérive du PIN saisi la même clé Argon2 que celle du hash du
//     Maître et en tire une preuve HMAC-SHA256(clé, nonce | contexte)
//     (`computePinProof`) ;
//  3. le Maître recalcule la preuve avec le hash qu'il possède (`verifyPinProof`).
// Le contexte lie la preuve à UNE opération (« verify », ou
// « decide:<demande>:<1|0> ») : une preuve capturée ne sert pas pour une autre
// décision, et le nonce n'est valable qu'une fois et 60 secondes. Un espion du
// réseau local peut toujours tester des PIN hors ligne contre une preuve
// capturée (même coût que contre un hash volé) — d'où le PIN de 6 chiffres
// minimum et le verrouillage progressif ; mais plus rien n'est lisible en clair
// ni rejouable.

export interface PinChallenge {
  nonce: string;
  /** Sel Argon2 du hash enregistré, en base64 (sans remplissage). */
  salt: string;
  memory: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

export const PIN_CHALLENGE_TTL_MS = 60_000;
const MAX_PENDING_CHALLENGES = 500;

interface ParsedPhc {
  memory: number;
  iterations: number;
  parallelism: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

function fromBase64(value: string): Uint8Array {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// `$argon2id$v=19$m=19456,t=2,p=1$<sel>$<hash>`
export function parseArgon2Phc(encoded: string): ParsedPhc {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[1] !== "argon2id") throw new Error("hash Argon2id invalide");
  const params = new Map(parts[3]!.split(",").map((kv) => kv.split("=") as [string, string]));
  const memory = Number(params.get("m"));
  const iterations = Number(params.get("t"));
  const parallelism = Number(params.get("p"));
  if (![memory, iterations, parallelism].every((n) => Number.isInteger(n) && n > 0)) throw new Error("paramètres Argon2 invalides");
  return { memory, iterations, parallelism, salt: fromBase64(parts[4]!), hash: fromBase64(parts[5]!) };
}

async function hmacHex(key: Uint8Array, message: string): Promise<string> {
  const hasher = await createHMAC(createSHA256(), key);
  hasher.init();
  hasher.update(message);
  return hasher.digest("hex");
}

/** Côté appareil relié : preuve de connaissance du PIN pour ce défi et ce contexte. */
export async function computePinProof(pin: string, challenge: PinChallenge, context: string): Promise<string> {
  const key = await argon2id({
    password: pin,
    salt: fromBase64(challenge.salt),
    iterations: challenge.iterations,
    memorySize: challenge.memory,
    parallelism: challenge.parallelism,
    hashLength: challenge.hashLength,
    outputType: "binary",
  });
  return hmacHex(key, `${challenge.nonce}|${context}`);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Défis en attente, côté Maître uniquement — en mémoire : un redémarrage les
// invalide, ce qui est voulu.
const pending = new Map<string, { approverId: number; kind: PinKind; expiresAt: number }>();

function purgeExpired(now: number): void {
  for (const [nonce, entry] of pending) if (entry.expiresAt <= now) pending.delete(nonce);
}

/** Quel PIN vise ce défi ? (à lire AVANT de vérifier la preuve, qui consomme le défi) */
export function pinChallengeKind(nonce: string): PinKind | undefined {
  return pending.get(nonce)?.kind;
}

export function pendingPinChallengeCount(): number {
  return pending.size;
}

/**
 * Côté Maître : émet un défi pour ce responsable (refusé s'il est verrouillé ou sans
 * PIN vérifiable ici). `kind` choisit le PIN visé : celui du déverrouillage de session
 * ou celui des approbations — deux secrets distincts, chacun avec son compteur d'essais.
 */
export async function issuePinChallenge(db: Database, approverId: number, now = Date.now(), kind: PinKind = "unlock"): Promise<PinChallenge> {
  const user = await db
    .select({
      pinHash: schema.users.pinHash,
      approvalPinHash: schema.users.approvalPinHash,
      isActive: schema.users.isActive,
      lockedUntil: schema.users.lockedUntil,
      approvalLockedUntil: schema.users.approvalLockedUntil,
    })
    .from(schema.users)
    .where(eq(schema.users.id, approverId))
    .get();
  const hash = kind === "approval" ? user?.approvalPinHash : user?.pinHash;
  if (!user || !user.isActive || !hash || isRemotePinHash(hash)) throw new Error(t("coreErrors.auth.pinChallengeInvalid"));
  const locked = remainingLockSeconds(kind === "approval" ? user.approvalLockedUntil : user.lockedUntil);
  if (locked > 0) throw new Error(t("coreErrors.common.tooManyAttempts", { seconds: locked }));

  purgeExpired(now);
  if (pending.size >= MAX_PENDING_CHALLENGES) throw new Error(t("coreErrors.auth.pinChallengeInvalid"));

  const parsed = parseArgon2Phc(hash);
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
  pending.set(nonce, { approverId, kind, expiresAt: now + PIN_CHALLENGE_TTL_MS });
  return {
    nonce,
    salt: hash.split("$")[4]!,
    memory: parsed.memory,
    iterations: parsed.iterations,
    parallelism: parsed.parallelism,
    hashLength: parsed.hash.length,
  };
}

/**
 * Côté Maître : vérifie une preuve. Le nonce est consommé quoi qu'il arrive
 * (aucun second essai sur le même défi), une preuve fausse compte comme un essai
 * raté (verrouillage progressif, comme un PIN saisi ici).
 */
export async function verifyPinProof(
  db: Database,
  approverId: number,
  nonce: string,
  context: string,
  proof: string,
  now = Date.now(),
  // Si fourni, le défi doit avoir été émis pour ce PIN-là (une décision
  // d'approbation n'accepte jamais une preuve du PIN de déverrouillage).
  expectedKind?: PinKind,
): Promise<boolean> {
  const entry = pending.get(nonce);
  pending.delete(nonce);
  if (!entry || entry.approverId !== approverId || entry.expiresAt <= now) return false;
  if (expectedKind && entry.kind !== expectedKind) return false;
  const kind = entry.kind;

  const user = await db
    .select({
      pinHash: schema.users.pinHash,
      approvalPinHash: schema.users.approvalPinHash,
      failedAttempts: schema.users.failedAttempts,
      approvalFailedAttempts: schema.users.approvalFailedAttempts,
      lockedUntil: schema.users.lockedUntil,
      approvalLockedUntil: schema.users.approvalLockedUntil,
      isActive: schema.users.isActive,
    })
    .from(schema.users)
    .where(eq(schema.users.id, approverId))
    .get();
  const hash = kind === "approval" ? user?.approvalPinHash : user?.pinHash;
  if (!user || !user.isActive || !hash || isRemotePinHash(hash)) return false;
  const locked = remainingLockSeconds(kind === "approval" ? user.approvalLockedUntil : user.lockedUntil);
  if (locked > 0) throw new Error(t("coreErrors.common.tooManyAttempts", { seconds: locked }));

  const expected = await hmacHex(parseArgon2Phc(hash).hash, `${nonce}|${context}`);
  if (!constantTimeEqual(expected, proof.toLowerCase())) {
    if (kind === "approval") await registerFailedApprovalAttempt(db, approverId, user.approvalFailedAttempts);
    else await registerFailedAttempt(db, approverId, user.failedAttempts);
    return false;
  }
  if (kind === "approval") await clearFailedApprovalAttempts(db, approverId);
  else await clearFailedAttempts(db, approverId);
  return true;
}

export const PIN_VERIFY_CONTEXT = "verify";
export function pinDecisionContext(requestSyncId: string, approve: boolean): string {
  return `decide:${requestSyncId}:${approve ? 1 : 0}`;
}
