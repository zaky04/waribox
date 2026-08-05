import { changeOwnPassword } from "@gestion-boutique/core";
import { useState } from "react";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";
import { useAuth } from "./useAuth";

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const db = useDatabase();
  const { user } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setError(null);
    if (newPassword.length < 8) {
      setError("Le nouveau mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("La confirmation ne correspond pas au nouveau mot de passe.");
      return;
    }
    if (!user) return;

    setSaving(true);
    try {
      await changeOwnPassword(db, user.id, currentPassword, newPassword);
      setSaved(true);
      setTimeout(onClose, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible de changer le mot de passe.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div style={{ ...cardStyle, width: 380, marginTop: 0 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0 }}>Changer mon mot de passe</h2>

        <label>
          Mot de passe actuel
          <input
            style={inputStyle}
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </label>
        <label>
          Nouveau mot de passe
          <input
            style={inputStyle}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={8}
          />
        </label>
        <label>
          Confirmer le nouveau mot de passe
          <input
            style={inputStyle}
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            minLength={8}
          />
        </label>

        {error && <p style={{ color: "#f87171" }}>{error}</p>}
        {saved && <p style={{ color: "#86efac" }}>Mot de passe modifié.</p>}

        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
            {saving ? "Enregistrement..." : "Enregistrer"}
          </button>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
              borderRadius: "var(--radius-md)",
              padding: "12px 18px",
              cursor: "pointer",
            }}
          >
            Annuler
          </button>
        </div>
      </div>
    </div>
  );
}
