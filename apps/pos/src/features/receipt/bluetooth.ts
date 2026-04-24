/*
 * Web Bluetooth ESC/POS print adapter.
 *
 * Printer matrix (v0 — narrow on purpose):
 *
 *   Vendor        Model           Paper  Service UUID                          Write characteristic
 *   -----         -----           -----  ----                                  -----
 *   EPSON         TM-m30          80mm   Serial Port Profile (vendor custom)   Vendor custom
 *   Xprinter      XP-P323B        58mm   18f0 (generic BLE printer service)    2af1
 *   Bixolon       SPP-R200III     58mm   Vendor custom                         Vendor custom
 *
 * We match on the well-known 18f0 (Xprinter, Goojprt, and most sub-USD$50
 * Android-friendly 58 mm printers) as the default. Merchants with vendor
 * printers will land on the fallback CSS sheet until we ship a vendor picker
 * in admin. This keeps the surface area honest: we promise Bluetooth on
 * widely-available commodity printers, and a clean browser-print fallback
 * everywhere else.
 */

const GENERIC_PRINTER_SERVICE = 0x18f0;
const GENERIC_PRINTER_WRITE_CHAR = 0x2af1;
const GATT_CHUNK_SIZE = 180;

export class BluetoothUnsupportedError extends Error {
  constructor() {
    super("web bluetooth is not available in this context");
    this.name = "BluetoothUnsupportedError";
  }
}

export class BluetoothPrintError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "BluetoothPrintError";
  }
}

export interface BluetoothPrinterAdapter {
  isSupported(): boolean;
  printReceipt(bytes: Uint8Array): Promise<void>;
}

interface NavigatorBluetoothHost {
  bluetooth?: {
    requestDevice(options: {
      filters?: Array<{ services?: Array<number | string> }>;
      optionalServices?: Array<number | string>;
      acceptAllDevices?: boolean;
    }): Promise<BluetoothDeviceLike>;
  };
}

interface BluetoothDeviceLike {
  name?: string;
  id: string;
  gatt?: {
    connect(): Promise<BluetoothGattServerLike>;
    disconnect(): void;
    connected: boolean;
  };
}

interface BluetoothGattServerLike {
  connected: boolean;
  disconnect(): void;
  getPrimaryService(uuid: number | string): Promise<BluetoothGattServiceLike>;
}

interface BluetoothGattServiceLike {
  getCharacteristic(uuid: number | string): Promise<BluetoothGattCharacteristicLike>;
}

interface BluetoothGattCharacteristicLike {
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  writeValue?(value: BufferSource): Promise<void>;
}

function getBluetoothHost(): NavigatorBluetoothHost | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator as unknown as NavigatorBluetoothHost;
}

export function isWebBluetoothSupported(): boolean {
  return Boolean(getBluetoothHost()?.bluetooth);
}

let pairedDevice: BluetoothDeviceLike | null = null;

async function ensureDevice(): Promise<BluetoothDeviceLike> {
  const host = getBluetoothHost();
  if (!host?.bluetooth) throw new BluetoothUnsupportedError();
  if (pairedDevice?.gatt?.connected) return pairedDevice;
  try {
    const device = await host.bluetooth.requestDevice({
      filters: [{ services: [GENERIC_PRINTER_SERVICE] }],
      optionalServices: [GENERIC_PRINTER_SERVICE],
    });
    pairedDevice = device;
    return device;
  } catch (err) {
    throw new BluetoothPrintError("pairing cancelled or failed", err);
  }
}

async function writeChunks(
  characteristic: BluetoothGattCharacteristicLike,
  bytes: Uint8Array,
): Promise<void> {
  const write =
    characteristic.writeValueWithoutResponse?.bind(characteristic) ??
    characteristic.writeValue?.bind(characteristic);
  if (!write) {
    throw new BluetoothPrintError("printer characteristic is not writable");
  }
  for (let offset = 0; offset < bytes.length; offset += GATT_CHUNK_SIZE) {
    const chunk = bytes.slice(offset, offset + GATT_CHUNK_SIZE);
    await write(chunk);
  }
}

export const webBluetoothPrinter: BluetoothPrinterAdapter = {
  isSupported: isWebBluetoothSupported,
  async printReceipt(bytes: Uint8Array) {
    if (!isWebBluetoothSupported()) throw new BluetoothUnsupportedError();
    const device = await ensureDevice();
    if (!device.gatt) {
      throw new BluetoothPrintError("paired device has no GATT server");
    }
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(GENERIC_PRINTER_SERVICE);
      const characteristic = await service.getCharacteristic(
        GENERIC_PRINTER_WRITE_CHAR,
      );
      await writeChunks(characteristic, bytes);
    } catch (err) {
      throw new BluetoothPrintError("print failed", err);
    }
  },
};

export function _resetBluetoothAdapterForTest(): void {
  pairedDevice = null;
}
