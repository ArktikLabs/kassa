import { db, type DeviceSecretRow } from "./index";

export type DeviceSecretInput = Omit<DeviceSecretRow, "id">;

export async function readDeviceSecret(): Promise<DeviceSecretRow | undefined> {
  return db.deviceSecret.get("singleton");
}

export async function writeDeviceSecret(secret: DeviceSecretInput): Promise<void> {
  await db.deviceSecret.put({ id: "singleton", ...secret });
}

/**
 * Erase the device secret and any derived caches. The fingerprint row is
 * intentionally preserved so a re-enrolled tablet still correlates to its
 * previous enrolment audit log entry (ARCHITECTURE.md §2.1). If catalog or
 * pending-sale tables land in later tickets, add them here.
 */
export async function resetDeviceCaches(): Promise<void> {
  await db.deviceSecret.clear();
}

export async function ensureFingerprint(): Promise<string> {
  const existing = await db.deviceMeta.get("singleton");
  if (existing) return existing.fingerprint;
  const fingerprint = crypto.randomUUID();
  await db.deviceMeta.put({ id: "singleton", fingerprint });
  return fingerprint;
}
