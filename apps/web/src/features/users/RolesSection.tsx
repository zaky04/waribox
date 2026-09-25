import {
  createRole,
  getRoleDisplayName,
  listRoles,
  PERMISSION_CATEGORIES,
  SENSITIVE_PERMISSIONS,
  updateRolePermissions,
  type Permission,
  type PermissionSet,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";
import { useAuth } from "../auth/useAuth";

type Role = typeof schema.roles.$inferSelect;

// Rôles sur mesure : un rôle = un ensemble de permissions. Le rôle Admin est
// verrouillé (toutes les permissions, non modifiable) pour qu'on ne puisse
// jamais se retrouver sans administrateur.
export function RolesSection({ onChanged }: { onChanged: () => void }) {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();

  const [roles, setRoles] = useState<Role[]>([]);
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<PermissionSet>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setRoles(await listRoles(db));
  }, [db]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startEdit = (role: Role) => {
    setEditingId(role.id);
    setName(role.name);
    setPerms(JSON.parse(role.permissions) as PermissionSet);
    setError(null);
    setSaved(false);
  };
  const startNew = () => {
    setEditingId("new");
    setName("");
    setPerms({});
    setError(null);
    setSaved(false);
  };

  const handleSave = async () => {
    if (!user) return;
    setError(null);
    setSaving(true);
    try {
      if (editingId === "new") {
        await createRole(db, { name, permissions: perms, userId: user.id }, user.permissions);
      } else if (editingId != null) {
        await updateRolePermissions(db, editingId, { permissions: perms, userId: user.id }, user.permissions);
      }
      setSaved(true);
      setEditingId(null);
      await refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const adminLocked = editingId != null && editingId !== "new" && roles.find((r) => r.id === editingId)?.name === "Admin";

  return (
    <div style={cardStyle}>
      <strong>{t("approvalRoles.title")}</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("approvalRoles.hint")}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {roles.map((r) => (
          <button
            key={r.id}
            style={{ ...primaryButtonStyle, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)", padding: "6px 12px" }}
            onClick={() => startEdit(r)}
          >
            {getRoleDisplayName(r.name)}
          </button>
        ))}
        <button style={{ ...primaryButtonStyle, padding: "6px 12px" }} onClick={startNew}>
          + {t("approvalRoles.newRole")}
        </button>
      </div>

      {editingId != null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px dashed var(--color-rule-strong)", paddingTop: 12 }}>
          {editingId === "new" ? (
            <label>
              {t("approvalRoles.name")}
              <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          ) : (
            <strong>
              {t("approvalRoles.editRole")} : {getRoleDisplayName(name)}
            </strong>
          )}
          {PERMISSION_CATEGORIES.map((cat) => (
            <div key={cat.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                <strong style={{ fontSize: 13.5 }}>{t(`permissions.categories.${cat.key}`)}</strong>
                {!adminLocked && (
                  <>
                    <button
                      type="button"
                      style={{ background: "transparent", border: "none", color: "var(--color-accent)", cursor: "pointer", fontSize: 12.5, padding: 0 }}
                      onClick={() => setPerms((prev) => ({ ...prev, ...Object.fromEntries(cat.permissions.map((p) => [p, true])) }))}
                    >
                      {t("permissions.checkAll")}
                    </button>
                    <button
                      type="button"
                      style={{ background: "transparent", border: "none", color: "var(--color-accent)", cursor: "pointer", fontSize: 12.5, padding: 0 }}
                      onClick={() => setPerms((prev) => ({ ...prev, ...Object.fromEntries(cat.permissions.map((p) => [p, false])) }))}
                    >
                      {t("permissions.uncheckAll")}
                    </button>
                  </>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 6 }}>
                {cat.permissions.map((p: Permission) => {
                  const sensitive = SENSITIVE_PERMISSIONS.includes(p);
                  const locked = adminLocked || (sensitive && user?.permissions[p] !== true);
                  return (
                    <label key={p} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                      <input
                        type="checkbox"
                        disabled={locked}
                        checked={adminLocked ? true : perms[p] === true}
                        onChange={(e) => setPerms((prev) => ({ ...prev, [p]: e.target.checked }))}
                      />
                      {sensitive ? "⚠ " : ""}
                      {t(`permissions.${p}`)}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
          {error && <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{error}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            {!adminLocked && (
              <button style={primaryButtonStyle} onClick={handleSave} disabled={saving}>
                {editingId === "new" ? t("approvalRoles.create") : t("approvalRoles.save")}
              </button>
            )}
          </div>
        </div>
      )}
      {saved && editingId == null && <p style={{ color: "var(--color-success)", fontSize: 13, margin: 0 }}>{t("approvalRoles.saved")}</p>}
    </div>
  );
}
