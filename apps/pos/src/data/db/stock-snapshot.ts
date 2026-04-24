import type { KassaDexie } from "./schema.ts";
import { stockSnapshotKey, type StockSnapshot } from "./types.ts";

export interface StockSnapshotRepo {
  forOutletItem(outletId: string, itemId: string): Promise<StockSnapshot | undefined>;
  forOutlet(outletId: string): Promise<StockSnapshot[]>;
  upsertMany(rows: readonly StockSnapshot[]): Promise<void>;
  applyOptimisticDelta(
    outletId: string,
    itemId: string,
    delta: number,
    occurredAt: string,
  ): Promise<StockSnapshot | undefined>;
}

export function stockSnapshotRepo(db: KassaDexie): StockSnapshotRepo {
  return {
    forOutletItem(outletId, itemId) {
      return db.stock_snapshot.get(stockSnapshotKey(outletId, itemId));
    },
    forOutlet(outletId) {
      return db.stock_snapshot.where("outletId").equals(outletId).toArray();
    },
    async upsertMany(rows) {
      if (rows.length === 0) return;
      const prepared: StockSnapshot[] = rows.map((row) => ({
        ...row,
        key: stockSnapshotKey(row.outletId, row.itemId),
      }));
      await db.stock_snapshot.bulkPut(prepared);
    },
    async applyOptimisticDelta(outletId, itemId, delta, occurredAt) {
      const key = stockSnapshotKey(outletId, itemId);
      return db.transaction("rw", db.stock_snapshot, async () => {
        const existing = await db.stock_snapshot.get(key);
        if (!existing) return undefined;
        const next: StockSnapshot = {
          ...existing,
          onHand: existing.onHand + delta,
          updatedAt: occurredAt,
        };
        await db.stock_snapshot.put(next);
        return next;
      });
    },
  };
}
