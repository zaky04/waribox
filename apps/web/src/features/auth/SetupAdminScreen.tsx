import { createUser, ensureDefaultRoles } from "@gestion-boutique/core";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { useSessionStore } from "../../stores/session";
import { authCardStyle, authInputStyle, authPrimaryButtonStyle } from "./styles";

export function SetupAdminScreen() {
  const db = useDatabase();
  const setUser = useSessionStore((s) => s.setUser);
  const { t } = useTranslation();

  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!username.trim()) {
      setError(t("auth.setupAdmin.errors.usernameRequired"));
      return;
    }
    if (password.length < 8) {
      setError(t("auth.setupAdmin.errors.passwordLength"));
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      setError(t("auth.setupAdmin.errors.pinFormat"));
      return;
    }

    setLoading(true);
    try {
      const roles = await ensureDefaultRoles(db);
      const admin = await createUser(
        db,
        {
          fullName,
          username,
          email: email.trim() || undefined,
          password,
          pin,
          roleId: roles.admin,
        },
        {},
      );
      setUser(admin);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message.includes("UNIQUE") ? t("auth.setupAdmin.errors.emailInUse") : message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ maxWidth: 420, margin: "60px auto", padding: 24 }}>
      <h1>{t("auth.setupAdmin.title")}</h1>
      <p style={{ color: "var(--color-text-muted)" }}>{t("auth.setupAdmin.hint")}</p>

      <form onSubmit={handleSubmit} style={authCardStyle}>
        <label>
          {t("auth.setupAdmin.fullName")}
          <input
            style={authInputStyle}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
          />
        </label>

        <label>
          {t("auth.setupAdmin.username")}
          <input
            style={authInputStyle}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>

        <label>
          {t("auth.setupAdmin.email")}
          <input
            type="email"
            style={authInputStyle}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label>
          {t("auth.setupAdmin.password")}
          <input
            type="password"
            style={authInputStyle}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>

        <label>
          {t("auth.setupAdmin.pin")}
          <input
            style={authInputStyle}
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            required
          />
        </label>

        {error && <p style={{ color: "var(--color-danger)" }}>{error}</p>}

        <button type="submit" style={authPrimaryButtonStyle} disabled={loading}>
          {loading ? t("auth.setupAdmin.creating") : t("auth.setupAdmin.submit")}
        </button>
      </form>
    </main>
  );
}
