import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "./useAuth";
import { authCardStyle, authInputStyle, authPrimaryButtonStyle } from "./styles";

export function LoginScreen() {
  const { login } = useAuth();
  const { t } = useTranslation();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(identifier, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ maxWidth: 420, margin: "60px auto", padding: 24 }}>
      <h1>{t("auth.login.title")}</h1>

      <form onSubmit={handleSubmit} style={authCardStyle}>
        <label>
          {t("auth.login.username")}
          <input
            type="text"
            style={authInputStyle}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            autoFocus
          />
        </label>

        <label>
          {t("auth.login.password")}
          <input
            type="password"
            style={authInputStyle}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {error && <p style={{ color: "var(--color-danger)" }}>{error}</p>}

        <button type="submit" style={authPrimaryButtonStyle} disabled={loading}>
          {loading ? t("auth.login.connecting") : t("auth.login.submit")}
        </button>
      </form>
    </main>
  );
}
