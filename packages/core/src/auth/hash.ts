import { argon2id, argon2Verify } from "hash-wasm";

// Paramètres alignés sur la recommandation OWASP pour Argon2id
// (m=19 MiB, t=2, p=1). outputType "encoded" produit une chaîne PHC
// auto-porteuse (sel + paramètres inclus) directement vérifiable.
const ITERATIONS = 2;
const MEMORY_SIZE_KIB = 19456;
const PARALLELISM = 1;
const HASH_LENGTH = 32;

function randomSalt(length = 16): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function hashSecret(secret: string): Promise<string> {
  return argon2id({
    password: secret,
    salt: randomSalt(),
    iterations: ITERATIONS,
    memorySize: MEMORY_SIZE_KIB,
    parallelism: PARALLELISM,
    hashLength: HASH_LENGTH,
    outputType: "encoded",
  });
}

export async function verifySecret(secret: string, hash: string): Promise<boolean> {
  return argon2Verify({ password: secret, hash });
}
