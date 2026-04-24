import type { KassaDexie } from "./schema.ts";
import type { SyncState, SyncTable } from "./types.ts";

export interface SyncStateRepo {
  get(table: SyncTable): Promise<SyncState | undefined>;
  all(): Promise<SyncState[]>;
  setPullCursor(table: SyncTable, cursor: string | null, pulledAt: string): Promise<SyncState>;
  setLastPushed(table: SyncTable, pushedAt: string): Promise<SyncState>;
}

async function upsert(
  db: KassaDexie,
  table: SyncTable,
  patch: Partial<Omit<SyncState, "table">>,
): Promise<SyncState> {
  return db.transaction("rw", db.sync_state, async () => {
    const existing = await db.sync_state.get(table);
    const next: SyncState = {
      table,
      cursor: existing?.cursor ?? null,
      lastPulledAt: existing?.lastPulledAt ?? null,
      lastPushedAt: existing?.lastPushedAt ?? null,
      ...patch,
    };
    await db.sync_state.put(next);
    return next;
  });
}

export function syncStateRepo(db: KassaDexie): SyncStateRepo {
  return {
    get(table) {
      return db.sync_state.get(table);
    },
    all() {
      return db.sync_state.toArray();
    },
    setPullCursor(table, cursor, pulledAt) {
      return upsert(db, table, { cursor, lastPulledAt: pulledAt });
    },
    setLastPushed(table, pushedAt) {
      return upsert(db, table, { lastPushedAt: pushedAt });
    },
  };
}
