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

import type { DeviceSecret } from "../data/db/index";
import {
  EnrolApiError,
  enrolDevice as enrolDeviceApi,
  type EnrolledDevice,
} from "../data/api/enrolment";

// Dexie + the data/db schema is the largest single block in the unenrolled
// cold-load bundle. Static-importing `getDatabase` from this module pulled
// the whole thing into the initial chunk because `enrolment.ts` is on the
// router's boot path. Dynamic-import keeps `data/db` out of the initial
// chunk; the first call resolves before TanStack Router's first redirect
// (KASA-157).
let dbModulePromise: Promise<typeof import("../data/db/index")> | null = null;
function loadDbModule(): Promise<typeof import("../data/db/index")> {
  if (!dbModulePromise) dbModulePromise = import("../data/db/index");
  return dbModulePromise;
}

export type EnrolmentSnapshot =
  | { state: "loading" }
  | { state: "unenrolled" }
  | { state: "enrolled"; device: EnrolledDevice };

type Listener = (snapshot: EnrolmentSnapshot) => void;

let snapshot: EnrolmentSnapshot = { state: "loading" };
const listeners = new Set<Listener>();
let hydration: Promise<EnrolmentSnapshot> | null = null;

function toEnrolled(row: DeviceSecret): EnrolledDevice {
  return {
    deviceId: row.deviceId,
    apiKey: row.apiKey,
    apiSecret: row.apiSecret,
    outlet: { id: row.outletId, name: row.outletName },
    merchant: { id: row.merchantId, name: row.merchantName },
  };
}

// Non-secret bool flag read by the inline script in `index.html` to suppress
// the enrol-screen LCP skeleton on enrolled cold launches (KASA-157). The
// device secret itself stays in Dexie per ARCHITECTURE.md §2.1 — only the
// boolean fact "this tablet has been enrolled" lands in localStorage.
const ENROLLED_FLAG_KEY = "kassa.enrolled";

function syncEnrolledFlag(state: EnrolmentSnapshot["state"]): void {
  if (typeof window === "undefined") return;
  try {
    if (state === "enrolled") {
      window.localStorage.setItem(ENROLLED_FLAG_KEY, "1");
    } else if (state === "unenrolled") {
      window.localStorage.removeItem(ENROLLED_FLAG_KEY);
    }
  } catch {
    // Private mode / disabled storage: the flag is best-effort, the skeleton
    // simply flashes once for these users on cold loads.
  }
}

function publish(next: EnrolmentSnapshot): void {
  snapshot = next;
  syncEnrolledFlag(next.state);
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
      const { getDatabase } = await loadDbModule();
      const { repos } = await getDatabase();
      const row = await repos.deviceSecret.get();
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
  const { getDatabase } = await loadDbModule();
  const { repos } = await getDatabase();
  const deviceFingerprint = await repos.deviceMeta.ensureFingerprint();
  const device = await enrolDeviceApi({ code: code.trim().toUpperCase(), deviceFingerprint });
  await repos.deviceSecret.set({
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

/**
 * Clear the stored device secret but keep the fingerprint so a re-enrolment
 * on the same tablet remains correlatable to its prior audit log entry.
 */
export async function resetDevice(): Promise<void> {
  const { getDatabase } = await loadDbModule();
  const { repos } = await getDatabase();
  await repos.deviceSecret.clear();
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
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(ENROLLED_FLAG_KEY);
    } catch {
      // ignore — same private-mode trap as syncEnrolledFlag
    }
  }
}

export { EnrolApiError };
