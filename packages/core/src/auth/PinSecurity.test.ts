import { schema } from "@gestion-boutique/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_PIN, CASHIER_PIN, seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, type TestDevice } from "../test/testDb";
import { createUser, setPin, updateUser, verifyPin } from "./AuthService";
import { lockoutSecondsForAttempts, remainingLockSeconds } from "./lockout";
import { isValidNewPin, REMOTE_PIN_HASH } from "./pin";
import { setRemotePinVerifier } from "./remotePin";

afterAll(() => {
  setRemotePinVerifier(null);
  releaseDevices();
});

describe("règle du PIN (pure)", () => {
  it("accepte 6 à 8 chiffres, refuse le reste", () => {
    for (const ok of ["123456", "1234567", "12345678"]) expect(isValidNewPin(ok)).toBe(true);
    for (const bad of ["", "1234", "12345", "123456789", "12345a", "12 456", "١٢٣٤٥٦"]) expect(isValidNewPin(bad)).toBe(false);
  });

  it("verrouillage progressif : 0 avant 5 erreurs, puis 30 s, 5 min, 30 min, 1 h", () => {
    expect([0, 1, 4].map(lockoutSecondsForAttempts)).toEqual([0, 0, 0]);
    expect([5, 9].map(lockoutSecondsForAttempts)).toEqual([30, 30]);
    expect([10, 14].map(lockoutSecondsForAttempts)).toEqual([300, 300]);
    expect([15, 19].map(lockoutSecondsForAttempts)).toEqual([1800, 1800]);
    expect([20, 500].map(lockoutSecondsForAttempts)).toEqual([3600, 3600]);
  });
});

describe("PIN sur une vraie base", () => {
  let device: TestDevice;
  let biz: SeededBusiness;

  beforeAll(async () => {
    device = await createDevice("master");
    biz = await seedBusiness(device.db!);
  });

  const userRow = (id: number) => device.db!.select().from(schema.users).where(eq(schema.users.id, id)).get();
  const expireLock = (id: number) => device.db!.update(schema.users).set({ lockedUntil: "2000-01-01 00:00:00" }).where(eq(schema.users.id, id)).run();

  it("refuse un PIN faible à la création, au changement et à la modification (côté service)", async () => {
    const db = device.db!;
    await expect(createUser(db, { fullName: "X", username: "x1", password: "motdepasse-x", pin: "1234", roleId: biz.roles.vendeur }, biz.admin.permissions)).rejects.toThrow();
    await expect(setPin(db, biz.cashier.id, "1234", biz.admin.permissions)).rejects.toThrow();
    await expect(setPin(db, biz.cashier.id, "abcdef", biz.admin.permissions)).rejects.toThrow();
    await expect(updateUser(db, biz.cashier.id, { pin: "12345" }, biz.admin.permissions)).rejects.toThrow();
    // Le PIN d'origine n'a pas bougé.
    expect(await verifyPin(db, biz.cashier.id, CASHIER_PIN)).toBe(true);
  });

  it("accepte un PIN de 6 à 8 chiffres", async () => {
    const db = device.db!;
    await setPin(db, biz.cashier.id, "9876543", biz.admin.permissions);
    expect(await verifyPin(db, biz.cashier.id, "9876543")).toBe(true);
    await setPin(db, biz.cashier.id, CASHIER_PIN, biz.admin.permissions);
  });

  it("un ancien PIN de 4 chiffres déjà enregistré continue de fonctionner", async () => {
    const db = device.db!;
    const { hashSecret } = await import("./hash");
    await db.update(schema.users).set({ pinHash: await hashSecret("4321") }).where(eq(schema.users.id, biz.manager.id)).run();
    expect(await verifyPin(db, biz.manager.id, "4321")).toBe(true);
  });

  it("verrouille au 5e échec, y compris avec le BON PIN pendant le verrou", async () => {
    const db = device.db!;
    for (let i = 0; i < 4; i++) expect(await verifyPin(db, biz.admin.id, "000000")).toBe(false);
    expect(remainingLockSeconds((await userRow(biz.admin.id))!.lockedUntil)).toBe(0);
    expect(await verifyPin(db, biz.admin.id, "000000")).toBe(false); // 5e
    const locked = await userRow(biz.admin.id);
    expect(locked!.failedAttempts).toBe(5); // le compteur n'est PLUS remis à zéro au verrouillage
    expect(remainingLockSeconds(locked!.lockedUntil)).toBeGreaterThan(20);
    await expect(verifyPin(db, biz.admin.id, ADMIN_PIN)).rejects.toThrow();
  });

  it("le verrou s'allonge : 30 s jusqu'à 9 erreurs, puis 5 min dès la 10e", async () => {
    const db = device.db!;
    for (let attempt = 6; attempt <= 9; attempt++) {
      await expireLock(biz.admin.id);
      expect(await verifyPin(db, biz.admin.id, "000000")).toBe(false);
      const row = await userRow(biz.admin.id);
      expect(row!.failedAttempts).toBe(attempt);
      const remaining = remainingLockSeconds(row!.lockedUntil);
      expect(remaining).toBeGreaterThan(20);
      expect(remaining).toBeLessThanOrEqual(30);
    }
    await expireLock(biz.admin.id);
    expect(await verifyPin(db, biz.admin.id, "000000")).toBe(false); // 10e
    const remaining = remainingLockSeconds((await userRow(biz.admin.id))!.lockedUntil);
    expect(remaining).toBeGreaterThan(290);
    expect(remaining).toBeLessThanOrEqual(300);
  });

  it("le bon PIN, une fois le verrou levé, remet le compteur à zéro", async () => {
    const db = device.db!;
    await expireLock(biz.admin.id);
    expect(await verifyPin(db, biz.admin.id, ADMIN_PIN)).toBe(true);
    const row = await userRow(biz.admin.id);
    expect(row!.failedAttempts).toBe(0);
    expect(row!.lockedUntil).toBeNull();
  });

  it("PIN « distant » : sans connexion au Maître, message clair ; avec, c'est le Maître qui répond", async () => {
    const db = device.db!;
    await db.update(schema.users).set({ pinHash: REMOTE_PIN_HASH }).where(eq(schema.users.id, biz.cashier.id)).run();
    setRemotePinVerifier(null);
    await expect(verifyPin(db, biz.cashier.id, CASHIER_PIN)).rejects.toThrow();
    const calls: Array<[number, string]> = [];
    setRemotePinVerifier(async (id, pin) => {
      calls.push([id, pin]);
      return pin === CASHIER_PIN;
    });
    expect(await verifyPin(db, biz.cashier.id, CASHIER_PIN)).toBe(true);
    expect(await verifyPin(db, biz.cashier.id, "111111")).toBe(false);
    expect(calls).toHaveLength(2);
    setRemotePinVerifier(null);
  });
});
