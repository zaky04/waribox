import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  PERMISSION_CATEGORIES,
  SENSITIVE_PERMISSIONS,
  PermissionError,
  applyOverrides,
  assertCanChangePermissions,
  parseOverrides,
} from "./permissions";

describe("catégories de permissions", () => {
  it("chaque permission est dans exactement une catégorie", () => {
    const all = PERMISSION_CATEGORIES.flatMap((c) => c.permissions);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...PERMISSIONS].sort());
  });
});

describe("droits particuliers", () => {
  const role = { manage_sales: true, manage_refunds: true };

  it("accorde ou retire par-dessus le rôle, le reste suit le rôle", () => {
    const eff = applyOverrides(role, { manage_stock: true, manage_refunds: false });
    expect(eff.manage_stock).toBe(true);
    expect(eff.manage_refunds).toBe(false);
    expect(eff.manage_sales).toBe(true);
  });

  it("lit du JSON invalide ou partiel sans planter, ignore les clés inconnues", () => {
    expect(parseOverrides(null)).toEqual({});
    expect(parseOverrides("pas du json")).toEqual({});
    expect(parseOverrides('{"manage_stock":true,"nimporte_quoi":true,"manage_sales":"oui"}')).toEqual({ manage_stock: true });
  });
});

describe("anti-escalade de droits sensibles", () => {
  const gerant = { manage_users: true, manage_stock: true };

  it("refuse d'accorder un droit sensible qu'on ne détient pas", () => {
    expect(() => assertCanChangePermissions(gerant, {}, { approve_actions: true })).toThrow(PermissionError);
  });

  it("refuse de retirer un droit sensible qu'on ne détient pas", () => {
    expect(() => assertCanChangePermissions(gerant, { view_audit_logs: true }, {})).toThrow(PermissionError);
  });

  it("autorise les droits ordinaires et les droits sensibles détenus", () => {
    expect(() => assertCanChangePermissions(gerant, {}, { manage_stock: true, manage_sales: true })).not.toThrow();
    expect(() => assertCanChangePermissions({ ...gerant, approve_actions: true }, {}, { approve_actions: true })).not.toThrow();
  });

  it("ne bloque pas un changement qui ne touche aucun droit sensible", () => {
    const before = { manage_sales: true, approve_actions: true };
    const after = { manage_sales: false, approve_actions: true };
    expect(() => assertCanChangePermissions(gerant, before, after)).not.toThrow();
  });

  it("la liste des droits sensibles ne contient que des permissions connues", () => {
    for (const p of SENSITIVE_PERMISSIONS) expect(PERMISSIONS).toContain(p);
  });
});
