import type { SyncTable } from "../db/types.ts";

/*
 * Tiny pub-sub store the ConnectionPill subscribes to. The sync engine
 * pushes state transitions here; UI reads the latest snapshot and gets
 * notified on changes. Kept deliberately dependency-free so it can be
 * unit-tested in isolation and consumed by the router/Root shell
 * without pulling in a state library.
 */

export type SyncPhase =
  | { kind: "idle"; lastSuccessAt: string | null; lastError: string | null }
  | { kind: "syncing"; table: SyncTable | null; pending: number }
  | { kind: "offline" }
  | { kind: "error"; message: string; table: SyncTable | null };

export interface SyncStatus {
  phase: SyncPhase;
}

export type SyncStatusListener = (status: SyncStatus) => void;

export interface SyncStatusStore {
  get(): SyncStatus;
  set(status: SyncStatus): void;
  update(patch: (current: SyncStatus) => SyncStatus): void;
  subscribe(listener: SyncStatusListener): () => void;
}

export function createSyncStatusStore(initial?: SyncStatus): SyncStatusStore {
  let current: SyncStatus =
    initial ??
    ({
      phase: { kind: "idle", lastSuccessAt: null, lastError: null },
    } satisfies SyncStatus);
  const listeners = new Set<SyncStatusListener>();
  return {
    get: () => current,
    set(next) {
      current = next;
      for (const fn of listeners) fn(current);
    },
    update(patch) {
      current = patch(current);
      for (const fn of listeners) fn(current);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
