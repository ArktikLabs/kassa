import type { KassaDexie } from "./schema.ts";
import type { Uom } from "./types.ts";

export interface UomsRepo {
  getById(id: string): Promise<Uom | undefined>;
  getByCode(code: string): Promise<Uom | undefined>;
  all(): Promise<Uom[]>;
  upsertMany(uoms: readonly Uom[]): Promise<void>;
}

export function uomsRepo(db: KassaDexie): UomsRepo {
  return {
    getById(id) {
      return db.uoms.get(id);
    },
    getByCode(code) {
      return db.uoms.where("code").equals(code).first();
    },
    all() {
      return db.uoms.orderBy("code").toArray();
    },
    async upsertMany(uoms) {
      if (uoms.length === 0) return;
      await db.uoms.bulkPut([...uoms]);
    },
  };
}
