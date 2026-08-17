import { t } from "@gestion-boutique/i18n";
import { EscPosBuilder } from "./escpos";
import { connectPrinter, type PrinterConnection, type PrinterTransport } from "./transport";

export class PrinterService {
  private connection: PrinterConnection | null = null;
  private transport: PrinterTransport | null = null;

  get isConnected(): boolean {
    return this.connection !== null;
  }

  get connectedTransport(): PrinterTransport | null {
    return this.transport;
  }

  async connect(transport: PrinterTransport): Promise<void> {
    const connection = await connectPrinter(transport);
    this.connection = connection;
    this.transport = transport;
  }

  async disconnect(): Promise<void> {
    await this.connection?.disconnect();
    this.connection = null;
    this.transport = null;
  }

  async print(data: Uint8Array): Promise<void> {
    if (!this.connection) {
      throw new Error(t("printerErrors.notConnected"));
    }
    await this.connection.write(data);
  }

  async openDrawer(): Promise<void> {
    if (!this.connection) {
      throw new Error(t("printerErrors.notConnected"));
    }
    await this.connection.write(new EscPosBuilder().kickDrawer().build());
  }
}
