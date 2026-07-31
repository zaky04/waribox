import {
  createUser,
  ensureDefaultRoles,
  listRoles,
  listUsers,
  setUserActive,
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
  const { user } = useAuth();

  const [users, setUsers] = useState<Awaited<ReturnType<typeof listUsers>>>([]);
  const [roles, setRoles] = useState<Role[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [roleId, setRoleId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    await ensureDefaultRoles(db);
    const [usersRows, rolesRows] = await Promise.all([listUsers(db), listRoles(db)]);
    setUsers(usersRows);
    setRoles(rolesRows);
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSubmit = async () => {
    setError(null);
    if (!fullName.trim() || !username.trim() || !roleId) {
      setError("Nom, pseudo et rôle sont requis.");
      return;
    }
    if (password.length < 8) {
      setError("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    if (pin && !/^\d{4}$/.test(pin)) {
      setError("Le code PIN doit contenir exactement 4 chiffres.");
      return;
    }

    setSaving(true);
    try {
      await createUser(
        db,
        {
          fullName: fullName.trim(),
          username: username.trim(),
          email: email.trim() || undefined,
          password,
          pin: pin || undefined,
          roleId: Number(roleId),
          createdBy: user?.id,
        },
        user?.permissions ?? {},
      );

      setFullName("");
      setUsername("");
      setEmail("");
      setPassword("");
      setPin("");
      setRoleId("");
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

  return (
    <main style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Utilisateurs</h1>
        <button style={primaryButtonStyle} onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Annuler" : "+ Nouvel utilisateur"}
        </button>
      </div>

      {showForm && (
        <div style={cardStyle}>
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
            Mot de passe
            <input
              style={inputStyle}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
            />
          </label>
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
          <label>
            Rôle
            <select style={inputStyle} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">— Choisir —</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>

          {error && <p style={{ color: "#f87171" }}>{error}</p>}

          <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
            {saving ? "Création..." : "Créer l'utilisateur"}
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
              <td style={tdStyle}>
                <span style={badgeStyle(u.isActive ? "ok" : "warning")}>
                  {u.isActive ? "Actif" : "Inactif"}
                </span>
              </td>
              <td style={tdStyle}>
                {u.id !== user?.id && (
                  <button
                    style={{
                      ...primaryButtonStyle,
                      padding: "6px 12px",
                      fontSize: 14,
                      background: "transparent",
                      border: "1px solid var(--color-border)",
                      color: "var(--color-text)",
                    }}
                    onClick={() => handleToggleActive(u)}
                  >
                    {u.isActive ? "Désactiver" : "Réactiver"}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {users.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={6}>
                Aucun utilisateur.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
