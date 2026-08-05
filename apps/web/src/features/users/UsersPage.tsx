import {
  createUser,
  ensureDefaultRoles,
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
      setError("Nom, pseudo et rôle sont requis.");
      return;
    }
    if (!editingUserId && password.length < 8) {
      setError("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    if (editingUserId && password && password.length < 8) {
      setError("Le nouveau mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    if (pin && !/^\d{4}$/.test(pin)) {
      setError("Le code PIN doit contenir exactement 4 chiffres.");
      return;
    }
    const needsStore = multiStoreEnabled && !roleCanSwitchStore(roleId);
    if (needsStore && !storeId) {
      setError("Ce rôle doit être rattaché à une boutique (il ne peut pas en changer lui-même).");
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
      setError(message.includes("UNIQUE") ? "Cet email est déjà utilisé." : message);
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
      setImpersonateError(err instanceof Error ? err.message : "Impossible d'ouvrir une session pour ce compte.");
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
        <h1>Utilisateurs</h1>
        <button
          style={primaryButtonStyle}
          onClick={() => (showForm ? setShowForm(false) : startCreate())}
        >
          {showForm ? "Annuler" : "+ Nouvel utilisateur"}
        </button>
      </div>

      {impersonateError && <p style={{ color: "#f87171" }}>{impersonateError}</p>}

      {showForm && (
        <div style={cardStyle}>
          <h2 style={{ margin: 0 }}>{editingUserId ? "Modifier l'utilisateur" : "Nouvel utilisateur"}</h2>
          <label>
            Nom complet
            <input style={inputStyle} value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </label>
          <label>
            Pseudo
            <input style={inputStyle} value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            Email (optionnel)
            <input
              style={inputStyle}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            {editingUserId ? "Nouveau mot de passe (laisser vide = inchangé)" : "Mot de passe"}
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
              Code PIN (4 chiffres, optionnel)
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
            Rôle
            <select
              style={inputStyle}
              value={roleId}
              onChange={(e) => {
                setRoleId(e.target.value);
                if (roleCanSwitchStore(e.target.value)) setStoreId("");
              }}
            >
              <option value="">— Choisir —</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          {multiStoreEnabled && roleId && !roleCanSwitchStore(roleId) && (
            <label>
              Boutique (ce rôle ne peut pas en changer lui-même)
              <select style={inputStyle} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                <option value="">— Choisir —</option>
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
              ? "Enregistrement..."
              : editingUserId
                ? "Enregistrer les modifications"
                : "Créer l'utilisateur"}
          </button>
        </div>
      )}

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Nom</th>
            <th style={thStyle}>Pseudo</th>
            <th style={thStyle}>Email</th>
            <th style={thStyle}>Rôle</th>
            {multiStoreEnabled && <th style={thStyle}>Boutique</th>}
            <th style={thStyle}>Statut</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={tdStyle}>{u.fullName}</td>
              <td style={tdStyle}>{u.username ?? "—"}</td>
              <td style={tdStyle}>{u.email ?? "—"}</td>
              <td style={tdStyle}>{u.roleName}</td>
              {multiStoreEnabled && (
                <td style={tdStyle}>
                  {u.storeId ? (stores.find((s) => s.id === u.storeId)?.name ?? "—") : "Toutes"}
                </td>
              )}
              <td style={tdStyle}>
                <span style={badgeStyle(u.isActive ? "ok" : "warning")}>
                  {u.isActive ? "Actif" : "Inactif"}
                </span>
              </td>
              <td style={tdStyle}>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={secondaryButtonStyle} onClick={() => startEdit(u)}>
                    Modifier
                  </button>
                  {u.id !== user?.id && (
                    <>
                      <button style={secondaryButtonStyle} onClick={() => handleToggleActive(u)}>
                        {u.isActive ? "Désactiver" : "Réactiver"}
                      </button>
                      {u.isActive && (
                        <button style={secondaryButtonStyle} onClick={() => handleImpersonate(u)}>
                          Se connecter en tant que
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
                Aucun utilisateur.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
