import { describe, expect, it } from "vitest";
import { BackupDecryptionError, decryptBackup, encryptBackup, isEncryptedBackup } from "./backupCrypto";

// Peu d'itérations pour garder les tests rapides : le format les porte dans l'en-tête.
const FAST = 1000;
const sample = () => new TextEncoder().encode("SQLite format 3\0" + "données de test ".repeat(500));

describe("chiffrement des sauvegardes", () => {
  it("chiffre puis déchiffre à l'identique", async () => {
    const original = sample();
    const encrypted = await encryptBackup(original, "mot de passe solide", FAST);
    expect(isEncryptedBackup(encrypted)).toBe(true);
    expect(isEncryptedBackup(original)).toBe(false);
    expect(await decryptBackup(encrypted, "mot de passe solide")).toEqual(original);
  });

  it("le contenu en clair n'apparaît pas dans le fichier chiffré", async () => {
    const encrypted = await encryptBackup(sample(), "x1y2z3", FAST);
    expect(new TextDecoder("latin1").decode(encrypted)).not.toContain("SQLite format 3");
    expect(new TextDecoder("latin1").decode(encrypted)).not.toContain("test");
  });

  it("un mauvais mot de passe est refusé", async () => {
    const encrypted = await encryptBackup(sample(), "bon", FAST);
    await expect(decryptBackup(encrypted, "mauvais")).rejects.toBeInstanceOf(BackupDecryptionError);
    await expect(decryptBackup(encrypted, "")).rejects.toBeInstanceOf(BackupDecryptionError);
  });

  it("un fichier altéré (un seul octet) est refusé plutôt que lu de travers", async () => {
    const encrypted = await encryptBackup(sample(), "bon", FAST);
    const tampered = encrypted.slice();
    tampered[tampered.length - 20] = tampered[tampered.length - 20]! ^ 0xff;
    await expect(decryptBackup(tampered, "bon")).rejects.toBeInstanceOf(BackupDecryptionError);
  });

  it("deux chiffrements du même contenu diffèrent (sel et IV aléatoires)", async () => {
    const a = await encryptBackup(sample(), "bon", FAST);
    const b = await encryptBackup(sample(), "bon", FAST);
    expect(a).not.toEqual(b);
  });

  it("un en-tête avec un nombre d'itérations absurde est refusé sans calcul", async () => {
    const encrypted = await encryptBackup(sample(), "bon", FAST);
    const bad = encrypted.slice();
    new DataView(bad.buffer).setUint32(8, 4_000_000_000, false);
    await expect(decryptBackup(bad, "bon")).rejects.toBeInstanceOf(BackupDecryptionError);
  });

  it("accepte les accents et les formes Unicode équivalentes du mot de passe", async () => {
    const encrypted = await encryptBackup(sample(), "café", FAST);
    expect(await decryptBackup(encrypted, "café")).toEqual(sample());
  });

  it("un fichier non chiffré ou trop court n'est pas reconnu", () => {
    expect(isEncryptedBackup(new Uint8Array(0))).toBe(false);
    expect(isEncryptedBackup(new Uint8Array(100))).toBe(false);
  });
});
