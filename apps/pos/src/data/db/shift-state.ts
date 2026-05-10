import type { KassaDexie } from "./schema.ts";
import type { ShiftState } from "./types.ts";

const SINGLETON_ID = "singleton" as const;

export interface ShiftStateRepo {
  /** Returns the open-shift singleton, or `undefined` if no shift is open. */
  get(): Promise<ShiftState | undefined>;
  /** Stamp the open-shift singleton; idempotent on `id`. */
  put(state: Omit<ShiftState, "id">): Promise<ShiftState>;
  /** Mark the open-shift row as locally closed; the boot guard treats a closed row as "no open shift". */
  markClosedLocally(closedAt: string): Promise<void>;
  /** Promote the row's `serverShiftId` once the server acknowledges the open. */
  recordServerShiftId(serverShiftId: string): Promise<void>;
  /** Drop the row entirely — used after the close has been acknowledged. */
  clear(): Promise<void>;
}

export function shiftStateRepo(db: KassaDexie): ShiftStateRepo {
  return {
    get() {
      return db.shift_state.get(SINGLETON_ID);
    },
    async put(state) {
      const row: ShiftState = { id: SINGLETON_ID, ...state };
      await db.shift_state.put(row);
      return row;
    },
    async markClosedLocally(closedAt) {
      const existing = await db.shift_state.get(SINGLETON_ID);
      if (!existing) return;
      await db.shift_state.update(SINGLETON_ID, { closedAt });
    },
    async recordServerShiftId(serverShiftId) {
      const existing = await db.shift_state.get(SINGLETON_ID);
      if (!existing) return;
      await db.shift_state.update(SINGLETON_ID, { serverShiftId });
    },
    async clear() {
      await db.shift_state.delete(SINGLETON_ID);
    },
  };
}
