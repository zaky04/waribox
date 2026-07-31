export interface PrinterConnection {
  write(data: Uint8Array): Promise<void>;
  disconnect(): Promise<void>;
}

export type PrinterTransport = "bluetooth" | "usb";

// UUID de service générique utilisé par la majorité des imprimantes thermiques
// Bluetooth LE (profil "port série sur BLE"). Certains modèles utilisent un
// UUID propriétaire différent — à ajuster ici si la connexion échoue avec un
// modèle spécifique.
const BLUETOOTH_SERVICE_UUID = "000018f0-0000-1000-8000-00805f9b34fb";
const BLUETOOTH_CHARACTERISTIC_UUID = "00002af1-0000-1000-8000-00805f9b34fb";

// Une écriture BLE unique dépasse rarement ~180-512 octets selon l'appareil ;
// on fragmente les tickets (souvent > 1 Ko) en plusieurs écritures.
const BLUETOOTH_CHUNK_SIZE = 180;

export function isBluetoothSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

export function isUsbSupported(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

async function connectBluetooth(): Promise<PrinterConnection> {
  if (!isBluetoothSupported()) {
    throw new Error("Web Bluetooth n'est pas disponible sur ce navigateur.");
  }

  const bluetooth = (navigator as unknown as { bluetooth: any }).bluetooth;
  const device = await bluetooth.requestDevice({
    filters: [{ services: [BLUETOOTH_SERVICE_UUID] }],
    optionalServices: [BLUETOOTH_SERVICE_UUID],
  });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(BLUETOOTH_SERVICE_UUID);
  const characteristic = await service.getCharacteristic(BLUETOOTH_CHARACTERISTIC_UUID);

  return {
    async write(data: Uint8Array) {
      for (let i = 0; i < data.length; i += BLUETOOTH_CHUNK_SIZE) {
        await characteristic.writeValueWithoutResponse(data.slice(i, i + BLUETOOTH_CHUNK_SIZE));
      }
    },
    async disconnect() {
      device.gatt?.disconnect();
    },
  };
}

async function connectUsb(): Promise<PrinterConnection> {
  if (!isUsbSupported()) {
    throw new Error("WebUSB n'est pas disponible sur ce navigateur.");
  }

  const usb = (navigator as unknown as { usb: any }).usb;
  const device = await usb.requestDevice({ filters: [] });
  await device.open();
  if (device.configuration === null) {
    await device.selectConfiguration(1);
  }
  const iface = device.configuration.interfaces[0];
  await device.claimInterface(iface.interfaceNumber);
  const endpoint = iface.alternate.endpoints.find((e: { direction: string }) => e.direction === "out");
  if (!endpoint) {
    throw new Error("Aucun point de sortie USB trouvé sur cet appareil.");
  }

  return {
    async write(data: Uint8Array) {
      await device.transferOut(endpoint.endpointNumber, data);
    },
    async disconnect() {
      await device.close();
    },
  };
}

export async function connectPrinter(transport: PrinterTransport): Promise<PrinterConnection> {
  return transport === "bluetooth" ? connectBluetooth() : connectUsb();
}
