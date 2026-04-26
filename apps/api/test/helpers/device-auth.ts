import type { DeviceAuthRecord, DeviceAuthRepository } from "../../src/auth/device-auth.js";
import {
  encodeApiKey,
  generateApiSecret,
  hashApiSecret,
} from "../../src/services/enrolment/credentials.js";

export interface TestDeviceCredentials {
  deviceId: string;
  merchantId: string;
  outletId: string;
  apiKey: string;
  apiSecret: string;
  authHeader: string;
}

export class FakeDeviceAuthRepository implements DeviceAuthRepository {
  private readonly devices = new Map<string, DeviceAuthRecord>();
  readonly touched: Array<{ deviceId: string; seenAt: Date }> = [];

  add(record: DeviceAuthRecord): void {
    this.devices.set(record.id, record);
  }

  setStatus(deviceId: string, status: DeviceAuthRecord["status"]): void {
    const row = this.devices.get(deviceId);
    if (!row) return;
    this.devices.set(deviceId, { ...row, status });
  }

  async findDevice(deviceId: string): Promise<DeviceAuthRecord | null> {
    return this.devices.get(deviceId) ?? null;
  }

  async touchDevice(deviceId: string, seenAt: Date): Promise<void> {
    this.touched.push({ deviceId, seenAt });
  }
}

/**
 * Seeds a device into the given repository and returns ready-to-use HTTP
 * Basic credentials. Use the returned `authHeader` directly:
 *
 *   await app.inject({ method: "GET", url, headers: { authorization: cred.authHeader } });
 */
export async function seedTestDevice(
  repository: DeviceAuthRepository & { add(record: DeviceAuthRecord): void },
  partial: {
    deviceId: string;
    merchantId: string;
    outletId: string;
    status?: DeviceAuthRecord["status"];
  },
): Promise<TestDeviceCredentials> {
  const apiSecret = generateApiSecret();
  const apiKeyHash = await hashApiSecret(apiSecret);
  const apiKey = encodeApiKey(partial.deviceId);
  repository.add({
    id: partial.deviceId,
    merchantId: partial.merchantId,
    outletId: partial.outletId,
    apiKeyHash,
    status: partial.status ?? "active",
  });
  const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`, "utf8").toString("base64")}`;
  return {
    deviceId: partial.deviceId,
    merchantId: partial.merchantId,
    outletId: partial.outletId,
    apiKey,
    apiSecret,
    authHeader,
  };
}
