/*
 * Enrolment orchestration.
 *
 * Owns the device lifecycle: boot-time hydration of the device secret, the
 * enrolment API call, and the reset flow. Everything persisted lives in
 * Dexie (`src/data/db`) — `device_secret` is never written to localStorage,
 * per ARCHITECTURE.md §2.1 and the M2 acceptance criteria.
 *
 * `isEnrolled()` is synchronous because TanStack Router's redirect happens
 * before the router subscribes to stores. We hydrate from Dexie once at
 * module import (`hydrateEnrolment`), cache the result, and notify
 * subscribers whenever the secret changes.
 */

import {
  ensureFingerprint,
  readDeviceSecret,
  resetDeviceCaches,
  writeDeviceSecret,
} from "../data/db/device-repo";
import type { DeviceSecretRow } from "../data/db/index";
import {
  EnrolApiError,
  enrolDevice as enrolDeviceApi,
  type EnrolledDevice,
} from "../data/api/enrolment";

export type EnrolmentSnapshot =
  | { state: "loading" }
  | { state: "unenrolled" }
  | { state: "enrolled"; device: EnrolledDevice };

type Listener = (snapshot: EnrolmentSnapshot) => void;

let snapshot: EnrolmentSnapshot = { state: "loading" };
const listeners = new Set<Listener>();
let hydration: Promise<EnrolmentSnapshot> | null = null;

function toEnrolled(row: DeviceSecretRow): EnrolledDevice {
  return {
    deviceId: row.deviceId,
    apiKey: row.apiKey,
    apiSecret: row.apiSecret,
    outlet: { id: row.outletId, name: row.outletName },
    merchant: { id: row.merchantId, name: row.merchantName },
  };
}

function publish(next: EnrolmentSnapshot): void {
  snapshot = next;
  for (const l of listeners) l(snapshot);
}

/**
 * Read the persisted device secret once and update the in-memory snapshot.
 * Idempotent — repeat calls reuse the same in-flight promise. Called at
 * `main.tsx` boot so `isEnrolled()` returns a correct answer by the time the
 * router evaluates its redirects.
 */
export function hydrateEnrolment(): Promise<EnrolmentSnapshot> {
  if (hydration) return hydration;
  hydration = (async () => {
    try {
      const row = await readDeviceSecret();
      const next: EnrolmentSnapshot = row
        ? { state: "enrolled", device: toEnrolled(row) }
        : { state: "unenrolled" };
      publish(next);
      return next;
    } catch {
      // Dexie failures (quota, private mode, corrupt DB) should not crash the
      // shell — treat as unenrolled so the clerk can retry enrolment.
      const next: EnrolmentSnapshot = { state: "unenrolled" };
      publish(next);
      return next;
    }
  })();
  return hydration;
}

export function getSnapshot(): EnrolmentSnapshot {
  return snapshot;
}

export function isEnrolled(): boolean {
  return snapshot.state === "enrolled";
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Exchange an enrolment code for a device key+secret, persist to Dexie, and
 * promote the in-memory snapshot to `enrolled`. Callers receive the resolved
 * `EnrolledDevice` for toast copy; errors are re-thrown as `EnrolApiError`.
 */
export async function enrolDevice(code: string): Promise<EnrolledDevice> {
  const deviceFingerprint = await ensureFingerprint();
  const device = await enrolDeviceApi({ code: code.trim().toUpperCase(), deviceFingerprint });
  await writeDeviceSecret({
    deviceId: device.deviceId,
    apiKey: device.apiKey,
    apiSecret: device.apiSecret,
    outletId: device.outlet.id,
    outletName: device.outlet.name,
    merchantId: device.merchant.id,
    merchantName: device.merchant.name,
    enrolledAt: new Date().toISOString(),
  });
  publish({ state: "enrolled", device });
  return device;
}

export async function resetDevice(): Promise<void> {
  await resetDeviceCaches();
  publish({ state: "unenrolled" });
}

/**
 * Test-only hook: each `describe` starts from a blank slate. Not part of the
 * app surface.
 */
export function _resetForTest(): void {
  snapshot = { state: "loading" };
  listeners.clear();
  hydration = null;
}

export { EnrolApiError };
