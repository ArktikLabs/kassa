import { createContext, useContext, useSyncExternalStore } from "react";
import type { SyncRunner, SyncStatus, SyncStatusStore } from "../data/sync/index.ts";

// Light-weight context module statically imported by RootLayout/admin/eod so
// the heavy `SyncProvider` (Dexie + sync runner) stays out of the initial
// chunk. Consumers fall back to no-op defaults until `<SyncProvider>` mounts
// from its dynamic-imported chunk (KASA-157).
export interface SyncContextValue {
  store: SyncStatusStore;
  runner: SyncRunner | null;
  triggerRefresh: () => Promise<void>;
  triggerPush: () => Promise<void>;
}

export const SyncContext = createContext<SyncContextValue | null>(null);

const DEFAULT_STATUS: SyncStatus = {
  phase: { kind: "idle", lastSuccessAt: null, lastError: null },
  needsAttentionCount: 0,
};

export function useSyncStatus(): SyncStatus {
  const ctx = useContext(SyncContext);
  const store = ctx?.store ?? null;
  return useSyncExternalStore(
    (listener) => (store ? store.subscribe(listener) : () => {}),
    () => (store ? store.get() : DEFAULT_STATUS),
    () => DEFAULT_STATUS,
  );
}

export function useSyncActions(): {
  triggerRefresh: () => Promise<void>;
  triggerPush: () => Promise<void>;
} {
  const ctx = useContext(SyncContext);
  return {
    triggerRefresh: ctx?.triggerRefresh ?? (async () => {}),
    triggerPush: ctx?.triggerPush ?? (async () => {}),
  };
}
