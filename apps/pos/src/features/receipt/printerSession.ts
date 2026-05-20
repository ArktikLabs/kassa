/*
 * Session-scoped Bluetooth-printer availability signal (KASA-309).
 *
 * Two questions the receipt UI needs to answer when picking a primary
 * action:
 *
 *   1. Does this browser expose Web Bluetooth at all? (iPadOS Safari does
 *      not — there is no point dangling a `Cetak` button in front of a
 *      cashier who can never pair.)
 *   2. Has Bluetooth pairing failed since the cashier opened the tab?
 *      Failures within a session are sticky — the next sale should land
 *      on PDF primary so the clerk does not burn another two-tap retry
 *      on a flaky printer before reaching the fallback.
 *
 * The signal resets on full reload because that matches the cashier's
 * mental model: "I rebooted the tablet, let me try the printer again."
 */

import { useSyncExternalStore } from "react";
import { isWebBluetoothSupported } from "./bluetooth.ts";

let sessionFailed = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function markBluetoothSessionFailed(): void {
  if (sessionFailed) return;
  sessionFailed = true;
  emit();
}

export function _resetPrinterSessionForTest(): void {
  sessionFailed = false;
  emit();
}

export function isBluetoothPrimaryAction(): boolean {
  return isWebBluetoothSupported() && !sessionFailed;
}

export function hasBluetoothSessionFailed(): boolean {
  return sessionFailed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React hook returning the receipt action layout the cashier should see
 * right now. `pdfPrimary` is true on iPadOS or after a session-scoped
 * pairing failure; otherwise the Bluetooth printer button is primary.
 * `showPrinterRetry` is true when Bluetooth is supported but PDF is now
 * primary — surfaces the secondary `Coba printer Bluetooth` button.
 */
export function useReceiptActionLayout(): {
  pdfPrimary: boolean;
  bluetoothSupported: boolean;
  showPrinterRetry: boolean;
} {
  const failed = useSyncExternalStore(
    subscribe,
    () => sessionFailed,
    () => false,
  );
  const bluetoothSupported = isWebBluetoothSupported();
  const pdfPrimary = !bluetoothSupported || failed;
  return {
    pdfPrimary,
    bluetoothSupported,
    showPrinterRetry: bluetoothSupported && failed,
  };
}
