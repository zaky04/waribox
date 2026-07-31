import { useState } from "react";
import { useAuth } from "./useAuth";
import { authPrimaryButtonStyle } from "./styles";

const KEYPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

export function PinLockScreen() {
  const { user, unlockWithPin, logout } = useAuth();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submitPin = async (candidate: string) => {
    setChecking(true);
    setError(null);
    try {
      await unlockWithPin(candidate);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPin("");
    } finally {
      setChecking(false);
    }
  };

  const handleKey = (key: string) => {
    if (checking) return;
    if (key === "⌫") {
      setPin((p) => p.slice(0, -1));
      return;
    }
    if (key === "") return;

    const next = (pin + key).slice(0, 4);
    setPin(next);
    if (next.length === 4) {
      submitPin(next);
    }
  };

  return (
    <main style={{ maxWidth: 320, margin: "60px auto", padding: 24, textAlign: "center" }}>
      <h1>Session verrouillée</h1>
      <p style={{ color: "var(--color-text-muted)" }}>{user?.fullName}</p>

      <div style={{ display: "flex", justifyContent: "center", gap: 12, margin: "24px 0" }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              border: "2px solid var(--color-accent)",
              background: pin.length > i ? "var(--gradient-accent)" : "transparent",
            }}
          />
        ))}
      </div>

      {error && <p style={{ color: "#f87171" }}>{error}</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {KEYPAD.map((key, i) => (
          <button
            key={i}
            onClick={() => handleKey(key)}
            disabled={key === "" || checking}
            style={{
              padding: "18px 0",
              fontSize: 20,
              borderRadius: 12,
              border: "none",
              background: key === "" ? "transparent" : "var(--color-bg-elevated)",
              color: "var(--color-text)",
              cursor: key === "" ? "default" : "pointer",
            }}
          >
            {key}
          </button>
        ))}
      </div>

      <button
        onClick={logout}
        style={{ ...authPrimaryButtonStyle, background: "transparent", color: "var(--color-text-muted)", marginTop: 24 }}
      >
        Se déconnecter
      </button>
    </main>
  );
}
