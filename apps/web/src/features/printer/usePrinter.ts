import { PrinterService, isBluetoothSupported, isUsbSupported, type PrinterTransport } from "@gestion-boutique/printer";
import { useCallback, useState } from "react";

// Instance unique partagée par toute l'app : la connexion imprimante doit
// survivre à la navigation entre les onglets Ventes/Produits/Stock.
const printerService = new PrinterService();

export function usePrinter() {
  const [connected, setConnected] = useState(printerService.isConnected);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async (transport: PrinterTransport) => {
    setError(null);
    setConnecting(true);
    try {
      await printerService.connect(transport);
      setConnected(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connexion à l'imprimante impossible.");
      setConnected(false);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await printerService.disconnect();
    setConnected(false);
  }, []);

  const print = useCallback(async (data: Uint8Array) => {
    setError(null);
    try {
      await printerService.print(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Impression impossible.";
      setError(message);
      throw new Error(message);
    }
  }, []);

  const openDrawer = useCallback(async () => {
    setError(null);
    try {
      await printerService.openDrawer();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ouverture du tiroir impossible.";
      setError(message);
      throw new Error(message);
    }
  }, []);

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
