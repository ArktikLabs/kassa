import type { KassaDexie } from "./schema.ts";
import type { ParkedSale } from "./types.ts";

/**
 * KASA-366 — parked carts. Local-only Dexie table (no outbox/sync); rows
 * are scoped to `(outletId, localShiftId)` so the tray auto-clears with
 * the shift and a parked cart from one outlet can't surface in another.
 */
export interface ParkedSalesRepo {
  put(row: ParkedSale): Promise<void>;
  getById(id: string): Promise<ParkedSale | undefined>;
  /** Rows for an outlet+shift, newest first. */
  listForShift(outletId: string, localShiftId: string): Promise<ParkedSale[]>;
  countForShift(outletId: string, localShiftId: string): Promise<number>;
  delete(id: string): Promise<void>;
  /** Drop every parked row for an outlet+shift. Called from shift close. */
  clearForShift(outletId: string, localShiftId: string): Promise<number>;
}

export function parkedSalesRepo(db: KassaDexie): ParkedSalesRepo {
  return {
    async put(row) {
      await db.parked_sales.put(row);
    },
    getById(id) {
      return db.parked_sales.get(id);
    },
    async listForShift(outletId, localShiftId) {
      const rows = await db.parked_sales
        .where("localShiftId")
        .equals(localShiftId)
        .filter((row) => row.outletId === outletId)
        .toArray();
      return rows.sort((a, b) => (b.parkedAt < a.parkedAt ? -1 : b.parkedAt > a.parkedAt ? 1 : 0));
    },
    async countForShift(outletId, localShiftId) {
      return db.parked_sales
        .where("localShiftId")
        .equals(localShiftId)
        .filter((row) => row.outletId === outletId)
        .count();
    },
    async delete(id) {
      await db.parked_sales.delete(id);
    },
    async clearForShift(outletId, localShiftId) {
      const ids = await db.parked_sales
        .where("localShiftId")
        .equals(localShiftId)
        .filter((row) => row.outletId === outletId)
        .primaryKeys();
      if (ids.length === 0) return 0;
      await db.parked_sales.bulkDelete(ids);
      return ids.length;
    },
  };
}
