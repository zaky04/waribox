import { cardStyle, primaryButtonStyle } from "../../components/sharedStyles";
import { usePrinter } from "./usePrinter";

const secondaryButtonStyle = {
  background: "transparent",
  border: "1px solid var(--color-border)",
  color: "var(--color-text)",
  borderRadius: 8,
  padding: "10px 16px",
  cursor: "pointer",
};

export function PrinterPanel() {
  const { connected, connecting, error, bluetoothSupported, usbSupported, connect, disconnect, openDrawer } =
    usePrinter();

  return (
    <div style={cardStyle}>
      <strong>Imprimante ticket</strong>
      <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
        Statut : {connected ? "Connectée" : "Non connectée"}
      </p>

      {!connected && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button
            style={primaryButtonStyle}
            onClick={() => connect("bluetooth")}
            disabled={connecting || !bluetoothSupported}
            title={!bluetoothSupported ? "Web Bluetooth non disponible sur ce navigateur" : undefined}
          >
            {connecting ? "Connexion..." : "Connecter en Bluetooth"}
          </button>
          <button
            style={primaryButtonStyle}
            onClick={() => connect("usb")}
            disabled={connecting || !usbSupported}
            title={!usbSupported ? "WebUSB non disponible sur ce navigateur" : undefined}
          >
            {connecting ? "Connexion..." : "Connecter en USB"}
          </button>
        </div>
      )}

      {connected && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button style={secondaryButtonStyle} onClick={() => openDrawer()}>
            Ouvrir le tiroir-caisse
          </button>
          <button style={secondaryButtonStyle} onClick={() => disconnect()}>
            Déconnecter
          </button>
        </div>
      )}

      {!bluetoothSupported && !usbSupported && (
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          Ni Web Bluetooth ni WebUSB ne sont disponibles ici (nécessite Chrome/Edge sur PC ou Android,
          en HTTPS ou localhost).
        </p>
      )}

      {error && <p style={{ color: "#f87171" }}>{error}</p>}
    </div>
  );
}
