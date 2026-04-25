import type { KassaDexie } from "./schema.ts";
import { eodClosureKey, type EodClosure } from "./types.ts";

export interface EodClosuresRepo {
  put(row: EodClosure): Promise<void>;
  get(outletId: string, businessDate: string): Promise<EodClosure | undefined>;
  listForOutlet(outletId: string): Promise<EodClosure[]>;
}

export function eodClosuresRepo(db: KassaDexie): EodClosuresRepo {
  return {
    async put(row) {
      // `key` is the canonical index; normalize here so callers cannot
      // accidentally persist a row keyed on something else.
      await db.eod_closures.put({ ...row, key: eodClosureKey(row.outletId, row.businessDate) });
    },
    get(outletId, businessDate) {
      return db.eod_closures.get(eodClosureKey(outletId, businessDate));
    },
    listForOutlet(outletId) {
      return db.eod_closures.where("outletId").equals(outletId).sortBy("businessDate");
    },
  };
}
