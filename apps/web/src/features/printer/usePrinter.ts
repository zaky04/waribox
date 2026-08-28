import { PrinterService, isBluetoothSupported, isUsbSupported, type PrinterTransport } from "@gestion-boutique/printer";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

// Instance unique partagée par toute l'app : la connexion imprimante doit
// survivre à la navigation entre les onglets Ventes/Produits/Stock.
const printerService = new PrinterService();

export function usePrinter() {
  const { t } = useTranslation();
  const [connected, setConnected] = useState(printerService.isConnected);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(
    async (transport: PrinterTransport) => {
      setError(null);
      setConnecting(true);
      try {
        await printerService.connect(transport);
        setConnected(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("printer.errors.connectFailed"));
        setConnected(false);
      } finally {
        setConnecting(false);
      }
    },
    [t],
  );

  const disconnect = useCallback(async () => {
    await printerService.disconnect();
    setConnected(false);
  }, []);

  const print = useCallback(
    async (data: Uint8Array) => {
      setError(null);
      try {
        await printerService.print(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : t("printer.errors.printFailed");
        setError(message);
        throw new Error(message);
      }
    },
    [t],
  );

  const openDrawer = useCallback(async () => {
    setError(null);
    try {
      await printerService.openDrawer();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("printer.errors.openDrawerFailed");
      setError(message);
      throw new Error(message);
    }
  }, [t]);

  return {
    connected,
    connecting,
    error,
    bluetoothSupported: isBluetoothSupported(),
    usbSupported: isUsbSupported(),
    connect,
    disconnect,
    print,
    openDrawer,
  };
}
