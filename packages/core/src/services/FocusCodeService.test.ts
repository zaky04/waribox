import { schema } from "@gestion-boutique/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, type SeededBusiness } from "../test/seed";
import { createDevice, releaseDevices, type TestDevice } from "../test/testDb";
import { hasFocusCode, setFocusCode, verifyFocusCode } from "./FocusCodeService";
import { setMaintenanceCode } from "./MaintenanceService";
import { buildCatalogSnapshot } from "../sync/snapshot";
import { getSettings, updateSettings } from "./SettingsService";

let device: TestDevice;
let biz: SeededBusiness;

beforeAll(async () => {
  device = await createDevice("master");
  biz = await seedBusiness(device.db!);
  await getSettings(device.db!);
});

afterAll(() => releaseDevices());

describe("code du mode focus", () => {
  it("sans code défini, aucun code n'est reconnu (l'interface laisse alors sortir librement)", async () => {
    expect(await hasFocusCode(device.db!)).toBe(false);
    expect(await verifyFocusCode(device.db!, "1234")).toBe(false);
  });

  it("refuse un code trop court et exige le droit manage_settings", async () => {
    await expect(setFocusCode(device.db!, { newCode: "12", userId: biz.admin.id, actingPermissions: biz.admin.permissions })).rejects.toThrow();
    await expect(setFocusCode(device.db!, { newCode: "123456", userId: biz.cashier.id, actingPermissions: biz.cashier.permissions })).rejects.toThrow();
  });

  it("définit le code, puis seul le bon code le reconnaît", async () => {
    await setFocusCode(device.db!, { newCode: "kiosque", userId: biz.admin.id, actingPermissions: biz.admin.permissions });
    expect(await hasFocusCode(device.db!)).toBe(true);
    expect(await verifyFocusCode(device.db!, "kiosque")).toBe(true);
    expect(await verifyFocusCode(device.db!, "autre")).toBe(false);
  });

  it("modifier un code existant exige l'ancien (ou le code de maintenance)", async () => {
    await expect(setFocusCode(device.db!, { newCode: "nouveau1", userId: biz.admin.id, actingPermissions: biz.admin.permissions })).rejects.toThrow();
    await expect(setFocusCode(device.db!, { newCode: "nouveau1", currentCode: "faux", userId: biz.admin.id, actingPermissions: biz.admin.permissions })).rejects.toThrow();
    await setFocusCode(device.db!, { newCode: "nouveau1", currentCode: "kiosque", userId: biz.admin.id, actingPermissions: biz.admin.permissions });
    expect(await verifyFocusCode(device.db!, "nouveau1")).toBe(true);
    expect(await verifyFocusCode(device.db!, "kiosque")).toBe(false);
  });

  it("code oublié : le code de maintenance permet de redéfinir le code, sans mélanger les compteurs", async () => {
    await setMaintenanceCode(device.db!, { newCode: "maintenance-123", userId: biz.admin.id, actingPermissions: biz.admin.permissions });
    // Les erreurs de saisie du code focus ne touchent pas le compteur de maintenance.
    for (let i = 0; i < 4; i++) expect(await verifyFocusCode(device.db!, "mauvais")).toBe(false);
    expect((await getSettings(device.db!)).maintenanceCodeFailedAttempts).toBe(0);
    await expect(setFocusCode(device.db!, { newCode: "reinit-777", maintenanceCode: "faux", userId: biz.admin.id, actingPermissions: biz.admin.permissions })).rejects.toThrow();
    await setFocusCode(device.db!, { newCode: "reinit-777", maintenanceCode: "maintenance-123", userId: biz.admin.id, actingPermissions: biz.admin.permissions });
    expect(await verifyFocusCode(device.db!, "reinit-777")).toBe(true);
  });

  it("anti-brute-force : après 5 erreurs le code du mode focus est verrouillé, le bon code aussi", async () => {
    for (let i = 0; i < 5; i++) expect(await verifyFocusCode(device.db!, "mauvais")).toBe(false);
    await expect(verifyFocusCode(device.db!, "reinit-777")).rejects.toThrow();
    await device.db!.update(schema.businessSettings).set({ focusCodeFailedAttempts: 0, focusCodeLockedUntil: null }).run();
    expect(await verifyFocusCode(device.db!, "reinit-777")).toBe(true);
  });

  it("updateSettings ne peut pas écraser le hash du code ni ses compteurs", async () => {
    const before = (await getSettings(device.db!)).focusCodeHash;
    await updateSettings(
      device.db!,
      { businessName: "Boutique test", focusCodeHash: "pirate", focusCodeFailedAttempts: 0, focusCodeLockedUntil: null } as never,
      biz.admin.permissions,
    );
    expect((await getSettings(device.db!)).focusCodeHash).toBe(before);
  });

  it("l'instantané envoyé aux appareils reliés reprend le hash du code focus (pour sortir hors ligne) mais pas celui de maintenance", async () => {
    const snapshot = await buildCatalogSnapshot(device.db!);
    expect(snapshot.businessSettings).toHaveProperty("focusCodeHash");
    expect(snapshot.businessSettings).not.toHaveProperty("maintenanceCodeHash");
  });
});
