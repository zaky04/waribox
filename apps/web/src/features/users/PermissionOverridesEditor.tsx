import {
  PERMISSION_CATEGORIES,
  SENSITIVE_PERMISSIONS,
  applyOverrides,
  type Permission,
  type PermissionOverrides,
  type PermissionSet,
} from "@gestion-boutique/core";
import { useTranslation } from "react-i18next";
import { inputStyle } from "../../components/sharedStyles";

type Choice = "inherit" | "allow" | "deny";

// Droits particuliers d'un utilisateur, par catégorie : pour chaque droit,
// « selon le rôle » (défaut), « autoriser » ou « interdire ». Le résultat est
// le rôle + ces exceptions — c'est ce qui permet, par exemple, de donner l'accès
// au stock à un caissier précis, ou de retirer le droit de rembourser à un
// gérant précis, sans créer un rôle entier.
export function PermissionOverridesEditor({
  rolePermissions,
  overrides,
  onChange,
  actingPermissions,
}: {
  rolePermissions: PermissionSet;
  overrides: PermissionOverrides;
  onChange: (next: PermissionOverrides) => void;
  actingPermissions: PermissionSet;
}) {
  const { t } = useTranslation();
  const effective = applyOverrides(rolePermissions, overrides);
  const effectiveCount = Object.values(effective).filter(Boolean).length;
  const total = PERMISSION_CATEGORIES.reduce((n, c) => n + c.permissions.length, 0);

  const choiceOf = (p: Permission): Choice => (overrides[p] === true ? "allow" : overrides[p] === false ? "deny" : "inherit");
  const setChoice = (p: Permission, choice: Choice) => {
    const next: PermissionOverrides = { ...overrides };
    if (choice === "inherit") delete next[p];
    else next[p] = choice === "allow";
    onChange(next);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px dashed var(--color-rule-strong)", paddingTop: 12 }}>
      <strong style={{ fontSize: 14 }}>{t("userRights.title")}</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 12.5, margin: 0 }}>{t("userRights.hint")}</p>
      <span style={{ fontSize: 12.5 }}>{t("userRights.effective", { count: effectiveCount, total })}</span>
      {PERMISSION_CATEGORIES.map((cat) => (
        <div key={cat.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <strong style={{ fontSize: 13 }}>{t(`permissions.categories.${cat.key}`)}</strong>
          {cat.permissions.map((p) => {
            const sensitive = SENSITIVE_PERMISSIONS.includes(p);
            const locked = sensitive && actingPermissions[p] !== true;
            const roleHas = rolePermissions[p] === true;
            return (
              <div key={p} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, justifyContent: "space-between" }}>
                <span style={{ fontSize: 13.5, flex: "1 1 220px" }}>
                  {sensitive ? "⚠ " : ""}
                  {t(`permissions.${p}`)}{" "}
                  <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                    ({roleHas ? t("userRights.roleHas") : t("userRights.roleLacks")})
                  </span>
                </span>
                <select
                  aria-label={t(`permissions.${p}`)}
                  style={{
                    ...inputStyle,
                    width: 150,
                    marginTop: 0,
                    color: choiceOf(p) === "allow" ? "var(--color-success)" : choiceOf(p) === "deny" ? "var(--color-danger)" : undefined,
                  }}
                  value={choiceOf(p)}
                  disabled={locked}
                  onChange={(e) => setChoice(p, e.target.value as Choice)}
                >
                  <option value="inherit">{t("userRights.inherit")}</option>
                  <option value="allow">{t("userRights.allow")}</option>
                  <option value="deny">{t("userRights.deny")}</option>
                </select>
              </div>
            );
          })}
        </div>
      ))}
      {Object.keys(overrides).length > 0 && (
        <button
          type="button"
          style={{ alignSelf: "flex-start", background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)", borderRadius: "var(--radius-md)", padding: "6px 12px", cursor: "pointer" }}
          onClick={() => onChange({})}
        >
          {t("userRights.reset")}
        </button>
      )}
    </div>
  );
}
