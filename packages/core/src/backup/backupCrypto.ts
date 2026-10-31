// Chiffrement des fichiers de sauvegarde par mot de passe.
//
// Une sauvegarde est la base entière : elle contient les hash des mots de passe et des
// PIN, les clients, les ventes... Dès qu'elle quitte l'appareil (Google Drive, clé USB,
// dossier Téléchargements d'un téléphone partagé), quiconque la trouve peut l'ouvrir. Avec
// un mot de passe, le fichier n'est qu'un bloc illisible sans lui.
//
// Format : MAGIC (8 octets) | itérations PBKDF2 (4 octets, big-endian) | sel (16) | IV (12)
// | texte chiffré AES-256-GCM (avec son étiquette d'authenticité de 16 octets). GCM détecte
// à la fois un mauvais mot de passe et un fichier altéré : le déchiffrement échoue dans les
// deux cas, jamais de données silencieusement fausses. Les itérations sont dans l'en-tête pour
// pouvoir les augmenter plus tard sans casser les anciennes sauvegardes.

const MAGIC = new TextEncoder().encode("WBXBKP1\0");
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const HEADER_LENGTH = MAGIC.length + 4 + SALT_LENGTH + IV_LENGTH;

export const BACKUP_PBKDF2_ITERATIONS = 600_000;
export const ENCRYPTED_BACKUP_EXTENSION = ".enc";

export class BackupDecryptionError extends Error {
  constructor() {
    super("BACKUP_DECRYPTION_FAILED");
    this.name = "BackupDecryptionError";
  }
}

/** Ce fichier est-il une sauvegarde chiffrée par ce module ? (lecture de l'en-tête seulement) */
export function isEncryptedBackup(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_LENGTH) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptBackup(bytes: Uint8Array, passphrase: string, iterations = BACKUP_PBKDF2_ITERATIONS): Promise<Uint8Array> {
  if (!passphrase) throw new Error("passphrase required");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(passphrase, salt, iterations);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, bytes as BufferSource));
  const out = new Uint8Array(HEADER_LENGTH + cipher.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, iterations, false);
  out.set(salt, MAGIC.length + 4);
  out.set(iv, MAGIC.length + 4 + SALT_LENGTH);
  out.set(cipher, HEADER_LENGTH);
  return out;
}

/** Déchiffre une sauvegarde ; lève BackupDecryptionError si le mot de passe est faux ou le fichier altéré. */
export async function decryptBackup(bytes: Uint8Array, passphrase: string): Promise<Uint8Array> {
  if (!isEncryptedBackup(bytes)) throw new BackupDecryptionError();
  const iterations = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.length, false);
  // Garde-fou : un en-tête altéré ne doit pas pouvoir bloquer l'appareil avec des milliards d'itérations.
  if (iterations < 1 || iterations > 10_000_000) throw new BackupDecryptionError();
  const salt = bytes.slice(MAGIC.length + 4, MAGIC.length + 4 + SALT_LENGTH);
  const iv = bytes.slice(MAGIC.length + 4 + SALT_LENGTH, HEADER_LENGTH);
  try {
    const key = await deriveKey(passphrase, salt, iterations);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, bytes.slice(HEADER_LENGTH) as BufferSource));
  } catch {
    throw new BackupDecryptionError();
  }
}
