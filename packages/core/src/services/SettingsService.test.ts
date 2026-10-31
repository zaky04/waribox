import { describe, expect, it } from "vitest";
import { changedAdvancedSettings } from "./SettingsService";

const current = { enableSales: true, enableStock: true, multiStoreEnabled: false, businessName: "A" };

describe("changedAdvancedSettings", () => {
  it("ignore les valeurs identiques (la page renvoie tous ses champs)", () => {
    expect(changedAdvancedSettings(current, { enableSales: true, multiStoreEnabled: false })).toEqual([]);
  });
  it("détecte un module désactivé ou un multi-boutique activé", () => {
    expect(changedAdvancedSettings(current, { enableStock: false, multiStoreEnabled: true }).sort()).toEqual(["enableStock", "multiStoreEnabled"]);
  });
  it("ignore les champs non avancés et les champs absents", () => {
    expect(changedAdvancedSettings(current, { businessName: "B", enableSales: undefined })).toEqual([]);
  });
});
