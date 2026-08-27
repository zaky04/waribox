import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const { connected, connecting, error, bluetoothSupported, usbSupported, connect, disconnect, openDrawer } =
    usePrinter();

  return (
    <div style={cardStyle}>
      <strong>{t("printer.title")}</strong>
      <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
        {t("printer.status")} {connected ? t("printer.connected") : t("printer.notConnected")}
      </p>

      {!connected && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button
            style={primaryButtonStyle}
            onClick={() => connect("bluetooth")}
            disabled={connecting || !bluetoothSupported}
            title={!bluetoothSupported ? t("printer.bluetoothUnavailableTitle") : undefined}
          >
            {connecting ? t("printer.connecting") : t("printer.connectBluetooth")}
          </button>
          <button
            style={primaryButtonStyle}
            onClick={() => connect("usb")}
            disabled={connecting || !usbSupported}
            title={!usbSupported ? t("printer.usbUnavailableTitle") : undefined}
          >
            {connecting ? t("printer.connecting") : t("printer.connectUsb")}
          </button>
        </div>
      )}

      {connected && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button style={secondaryButtonStyle} onClick={() => openDrawer()}>
            {t("printer.openDrawer")}
          </button>
          <button style={secondaryButtonStyle} onClick={() => disconnect()}>
            {t("printer.disconnect")}
          </button>
        </div>
      )}

      {!bluetoothSupported && !usbSupported && (
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("printer.noneAvailable")}</p>
      )}

      {error && <p style={{ color: "var(--color-danger)" }}>{error}</p>}
    </div>
  );
}
