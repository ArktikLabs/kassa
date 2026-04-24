import { useSyncExternalStore } from "react";

/*
 * Tiny state container for PWA update / offline-ready signals.
 *
 * Decoupled from `virtual:pwa-register` so React components and tests
 * can drive the UI without booting the real service-worker registrar.
 * The bootstrap in `./pwa.ts` is the only thing that wires the actual
 * `registerSW` callbacks into `markUpdateAvailable` / `markOfflineReady`.
 */

export type PwaState = {
  updateAvailable: boolean;
  offlineReady: boolean;
};

let state: PwaState = { updateAvailable: false, offlineReady: false };
const listeners = new Set<() => void>();
let acceptHandler: (() => Promise<void> | void) | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function setState(next: PwaState) {
  if (next.updateAvailable === state.updateAvailable && next.offlineReady === state.offlineReady) {
    return;
  }
  state = next;
  emit();
}

export function markUpdateAvailable(accept: () => Promise<void> | void): void {
  acceptHandler = accept;
  setState({ ...state, updateAvailable: true });
}

export function markOfflineReady(): void {
  setState({ ...state, offlineReady: true });
}

export function acceptUpdate(): void {
  const handler = acceptHandler;
  acceptHandler = null;
  setState({ ...state, updateAvailable: false });
  void handler?.();
}

export function dismissOfflineReady(): void {
  setState({ ...state, offlineReady: false });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PwaState {
  return state;
}

export function usePwaState(): PwaState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function _resetPwaStoreForTest(): void {
  state = { updateAvailable: false, offlineReady: false };
  acceptHandler = null;
  listeners.clear();
}
