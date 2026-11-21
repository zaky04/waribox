import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateBackupProbe, sameBytes } from "../backup/verifyBackup";
import { createDevice, releaseDevices, useDevice, type TestDevice } from "../test/testDb";
import { getLastSuccessfulBackup, recordBackup } from "./BackupService";

const healthy = { integrity: "ok", counts: { users: 3, products: 10, sales: 40, business_settings: 1, customers: 5, stock_movements: 99 } };

describe("verdict d'un test de restauration", () => {
  it("une base saine et complète est restaurable", () => {
    expect(evaluateBackupProbe(healthy)).toEqual({ ok: true });
    expect(evaluateBackupProbe({ ...healthy, counts: { ...healthy.counts, sales: 0, products: 0 } })).toEqual({ ok: true }); // commerce neuf
  });

  it("un fichier abîmé, une table absente ou sans compte ne l'est pas", () => {
    expect(evaluateBackupProbe({ ...healthy, integrity: "*** in database main ***" })).toEqual({ ok: false, reason: "integrity" });
    expect(evaluateBackupProbe({ ...healthy, counts: { ...healthy.counts, sales: null } })).toEqual({ ok: false, reason: "missing:sales" });
    expect(evaluateBackupProbe({ ...healthy, counts: { ...healthy.counts, users: 0 } })).toEqual({ ok: false, reason: "noUsers" });
    expect(evaluateBackupProbe({ integrity: "ok", counts: {} })).toEqual({ ok: false, reason: "missing:users" });
  });

  it("compare des octets", () => {
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});

describe("historique des sauvegardes", () => {
  let device: TestDevice;
  beforeAll(async () => {
    device = await createDevice("backups");
  });
  afterAll(releaseDevices);

  it("une sauvegarde vérifiée compte comme réussie, une non restaurable ou en erreur non", async () => {
    useDevice(device);
    expect(await getLastSuccessfulBackup(device.db!, "local")).toBeUndefined();
    await recordBackup(device.db!, { destination: "local", fileRef: "a", status: "verify_failed" });
    await recordBackup(device.db!, { destination: "local", fileRef: "b", status: "error" });
    expect(await getLastSuccessfulBackup(device.db!, "local")).toBeUndefined(); // la prochaine vérification retentera
    await recordBackup(device.db!, { destination: "local", fileRef: "c", status: "success" });
    expect((await getLastSuccessfulBackup(device.db!, "local"))?.fileRef).toBe("c");
    await recordBackup(device.db!, { destination: "local", fileRef: "d", status: "verified" });
    expect((await getLastSuccessfulBackup(device.db!, "local"))?.fileRef).toBe("d");
    await recordBackup(device.db!, { destination: "local", fileRef: "e", status: "verify_failed" });
    expect((await getLastSuccessfulBackup(device.db!, "local"))?.fileRef).toBe("d");
    expect(await getLastSuccessfulBackup(device.db!, "google_drive")).toBeUndefined();
  });
});
