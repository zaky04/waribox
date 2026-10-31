import { describe, expect, it } from "vitest";
import { PERMISSIONS, PERMISSION_PARENTS, applyOverrides, inheritSplitPermissions } from "./permissions";
import { computeUncovered } from "../services/ServiceOrdersService";

describe("droits découpés", () => {
  it("un rôle qui pouvait gérer le stock garde tous les droits de stock", () => {
    const { merged, changed } = inheritSplitPermissions({ manage_stock: true });
    expect(changed).toBe(true);
    expect(merged.transfer_stock).toBe(true);
    expect(merged.record_stock_losses).toBe(true);
    expect(merged.manage_inventory).toBe(true);
    expect(merged.receive_purchases).toBe(true);
  });

  it("un rôle sans le droit d'origine ne gagne rien", () => {
    const { merged } = inheritSplitPermissions({ manage_sales: true });
    expect(merged.transfer_stock).toBe(false);
    expect(merged.open_close_cash).toBe(true);
    expect(merged.sell_on_credit).toBe(true);
  });

  it("ne touche pas un droit déjà réglé", () => {
    const { merged } = inheritSplitPermissions({ manage_stock: true, record_stock_losses: false });
    expect(merged.record_stock_losses).toBe(false);
    expect(merged.transfer_stock).toBe(true);
  });

  it("interdire le droit d'origine à une personne interdit aussi ses droits découpés", () => {
    const role = inheritSplitPermissions({ manage_stock: true }).merged;
    const eff = applyOverrides(role, { manage_stock: false });
    expect(eff.transfer_stock).toBe(false);
    expect(eff.manage_inventory).toBe(false);
  });

  it("une exception propre au droit découpé l'emporte", () => {
    const role = inheritSplitPermissions({ manage_stock: true }).merged;
    const eff = applyOverrides(role, { manage_stock: false, transfer_stock: true });
    expect(eff.transfer_stock).toBe(true);
    expect(eff.manage_inventory).toBe(false);
  });

  it("autoriser le droit d'origine à une personne donne aussi ses droits découpés", () => {
    const role = inheritSplitPermissions({ manage_sales: true }).merged;
    const eff = applyOverrides(role, { manage_stock: true });
    expect(eff.record_stock_losses).toBe(true);
  });

  it("chaque droit découpé est un droit connu", () => {
    for (const [child, parents] of Object.entries(PERMISSION_PARENTS)) {
      expect(PERMISSIONS).toContain(child);
      for (const p of parents!) expect(PERMISSIONS).toContain(p);
    }
  });
});

describe("ticket de service : solde à payer", () => {
  it("non payé au dépôt : le solde entier est à payer, sans crédit", () => {
    expect(computeUncovered(1000, 0, 0)).toBe(1000);
  });
  it("acompte : seul le reste est à payer", () => {
    expect(computeUncovered(1000, 400, 0)).toBe(600);
  });
  it("une fois transformé en créance, plus rien n'est à payer", () => {
    expect(computeUncovered(1000, 400, 600)).toBe(0);
  });
  it("soldé : rien", () => {
    expect(computeUncovered(1000, 1000, 0)).toBe(0);
  });
});

import { isReplicableRequest } from "../services/ApprovalService";
import { ROLE_TEMPLATES } from "./roleTemplates";

describe("demandes répliquées vers les autres appareils", () => {
  it("une dépense se réplique", () => {
    expect(isReplicableRequest("expense", {})).toBe(true);
  });
  it("un mouvement de stock manuel se réplique s'il a des identifiants universels", () => {
    expect(isReplicableRequest("stock", { movementSyncIds: ["a"] })).toBe(true);
    expect(isReplicableRequest("stock", { movementIds: [1] })).toBe(false);
  });
  it("les points restent propres à l'appareil", () => {
    expect(isReplicableRequest("points", {})).toBe(false);
  });
});

describe("modèles de rôles", () => {
  it("ne contiennent que des droits connus et aucun droit d'approbation ni d'administration", () => {
    for (const perms of Object.values(ROLE_TEMPLATES)) {
      for (const key of Object.keys(perms)) {
        expect(PERMISSIONS).toContain(key);
        expect(key.startsWith("approve_")).toBe(false);
        expect(["manage_users", "manage_settings", "manage_backups", "switch_store", "view_audit_logs"]).not.toContain(key);
      }
    }
  });
});
