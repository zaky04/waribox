import {
  createUser,
  ensureDefaultRoles,
  getRoleDisplayName,
  getSettings,
  hasPermission,
  listRoles,
  listStores,
  listUsers,
  setUserActive,
  updateUser,
  type PermissionSet,
} from "@gestion-boutique/core";
import { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import {
  badgeStyle,
  cardStyle,
  inputStyle,
  pageStyle,
  primaryButtonStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "../../components/sharedStyles";
import { useAuth } from "../auth/useAuth";

type Role = typeof schema.roles.$inferSelect;

export function UsersPage() {
  const db = useDatabase();
  const { user, impersonateUserById } = useAuth();
  const { t } = useTranslation();

  const [users, setUsers] = useState<Awaited<ReturnType<typeof listUsers>>>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [stores, setStores] = useState<Awaited<ReturnType<typeof listStores>>>([]);
  const [multiStoreEnabled, setMultiStoreEnabled] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [roleId, setRoleId] = useState<string>("");
  const [storeId, setStoreId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [impersonateError, setImpersonateError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    await ensureDefaultRoles(db);
    const [usersRows, rolesRows, storeRows, settings] = await Promise.all([
      listUsers(db),
      listRoles(db),
      listStores(db),
      getSettings(db),
    ]);
    setUsers(usersRows);
    setRoles(rolesRows);
    setStores(storeRows);
    setMultiStoreEnabled(settings.multiStoreEnabled);
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const roleCanSwitchStore = (id: string) => {
    const role = roles.find((r) => String(r.id) === id);
    if (!role) return true;
    return hasPermission(JSON.parse(role.permissions) as PermissionSet, "switch_store");
  };

  const resetForm = () => {
    setFullName("");
    setUsername("");
    setEmail("");
    setPassword("");
    setPin("");
    setRoleId("");
    setStoreId("");
    setEditingUserId(null);
    setError(null);
  };

  const startCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const startEdit = (target: (typeof users)[number]) => {
    setEditingUserId(target.id);
    setFullName(target.fullName);
    setUsername(target.username ?? "");
    setEmail(target.email ?? "");
    setPassword("");
    setPin("");
    const role = roles.find((r) => r.name === target.roleName);
    setRoleId(role ? String(role.id) : "");
    setStoreId(target.storeId ? String(target.storeId) : "");
    setError(null);
    setShowForm(true);
  };

  const handleSubmit = async () => {
    setError(null);
    if (!fullName.trim() || !username.trim() || !roleId) {
      setError(t("users.errors.requiredFields"));
      return;
    }
    if (!editingUserId && password.length < 8) {
      setError(t("users.errors.passwordLength"));
      return;
    }
    if (editingUserId && password && password.length < 8) {
      setError(t("users.errors.newPasswordLength"));
      return;
    }
    if (pin && !/^\d{4}$/.test(pin)) {
      setError(t("users.errors.pinFormat"));
      return;
    }
    const needsStore = multiStoreEnabled && !roleCanSwitchStore(roleId);
    if (needsStore && !storeId) {
      setError(t("users.errors.storeRequired"));
      return;
    }

    setSaving(true);
    try {
      const resolvedStoreId = needsStore ? Number(storeId) : null;
      if (editingUserId) {
        await updateUser(
          db,
          editingUserId,
          {
            fullName: fullName.trim(),
            username: username.trim(),
            email: email.trim() || undefined,
            roleId: Number(roleId),
            storeId: resolvedStoreId,
            newPassword: password || undefined,
          },
          user?.permissions ?? {},
          user?.id,
        );
      } else {
        await createUser(
          db,
          {
            fullName: fullName.trim(),
            username: username.trim(),
            email: email.trim() || undefined,
            password,
            pin: pin || undefined,
            roleId: Number(roleId),
            storeId: resolvedStoreId,
            createdBy: user?.id,
          },
          user?.permissions ?? {},
        );
      }

      resetForm();
      setShowForm(false);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message.includes("UNIQUE") ? t("users.errors.emailInUse") : message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (target: (typeof users)[number]) => {
    await setUserActive(db, target.id, !target.isActive, user?.permissions ?? {}, user?.id);
    await refresh();
  };

  const handleImpersonate = async (target: (typeof users)[number]) => {
    setImpersonateError(null);
    try {
      await impersonateUserById(target.id);
    } catch (err) {
      setImpersonateError(err instanceof Error ? err.message : t("users.errors.impersonateFailed"));
    }
  };

  const secondaryButtonStyle = {
    ...primaryButtonStyle,
    padding: "6px 12px",
    fontSize: 14,
    background: "transparent",
    border: "1px solid var(--color-border)",
    color: "var(--color-text)",
  };

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>{t("users.title")}</h1>
        <button
          style={primaryButtonStyle}
          onClick={() => (showForm ? setShowForm(false) : startCreate())}
        >
          {showForm ? t("users.cancel") : t("users.new")}
        </button>
      </div>

      {impersonateError && <p style={{ color: "#f87171" }}>{impersonateError}</p>}

      {showForm && (
        <div style={cardStyle}>
          <h2 style={{ margin: 0 }}>{editingUserId ? t("users.editTitle") : t("users.newTitle")}</h2>
          <label>
            {t("users.fullName")}
            <input style={inputStyle} value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </label>
          <label>
            {t("users.username")}
            <input style={inputStyle} value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            {t("users.email")}
            <input
              style={inputStyle}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            {editingUserId ? t("users.newPassword") : t("users.password")}
            <input
              style={inputStyle}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
            />
          </label>
          {!editingUserId && (
            <label>
              {t("users.pin")}
              <input
                style={inputStyle}
                inputMode="numeric"
                maxLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              />
            </label>
          )}
          <label>
            {t("users.role")}
            <select
              style={inputStyle}
              value={roleId}
              onChange={(e) => {
                setRoleId(e.target.value);
                if (roleCanSwitchStore(e.target.value)) setStoreId("");
              }}
            >
              <option value="">{t("users.chooseOption")}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {getRoleDisplayName(r.name)}
                </option>
              ))}
            </select>
          </label>
          {multiStoreEnabled && roleId && !roleCanSwitchStore(roleId) && (
            <label>
              {t("users.storeLabel")}
              <select style={inputStyle} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                <option value="">{t("users.chooseOption")}</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {error && <p style={{ color: "#f87171" }}>{error}</p>}

          <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
            {saving
              ? t("users.saving")
              : editingUserId
                ? t("users.saveChanges")
                : t("users.create")}
          </button>
        </div>
      )}

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>{t("users.name")}</th>
            <th style={thStyle}>{t("users.username")}</th>
            <th style={thStyle}>{t("users.emailColumn")}</th>
            <th style={thStyle}>{t("users.role")}</th>
            {multiStoreEnabled && <th style={thStyle}>{t("users.storeColumn")}</th>}
            <th style={thStyle}>{t("users.status")}</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={tdStyle}>{u.fullName}</td>
              <td style={tdStyle}>{u.username ?? "—"}</td>
              <td style={tdStyle}>{u.email ?? "—"}</td>
              <td style={tdStyle}>{getRoleDisplayName(u.roleName)}</td>
              {multiStoreEnabled && (
                <td style={tdStyle}>
                  {u.storeId ? (stores.find((s) => s.id === u.storeId)?.name ?? "—") : t("users.allStores")}
                </td>
              )}
              <td style={tdStyle}>
                <span style={badgeStyle(u.isActive ? "ok" : "warning")}>
                  {u.isActive ? t("users.active") : t("users.inactive")}
                </span>
              </td>
              <td style={tdStyle}>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={secondaryButtonStyle} onClick={() => startEdit(u)}>
                    {t("users.edit")}
                  </button>
                  {u.id !== user?.id && (
                    <>
                      <button style={secondaryButtonStyle} onClick={() => handleToggleActive(u)}>
                        {u.isActive ? t("users.deactivate") : t("users.reactivate")}
                      </button>
                      {u.isActive && (
                        <button style={secondaryButtonStyle} onClick={() => handleImpersonate(u)}>
                          {t("users.impersonate")}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {users.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={multiStoreEnabled ? 7 : 6}>
                {t("users.none")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
