import type { KassaDexie } from "./schema.ts";
import type { Bom } from "./types.ts";

export interface BomsRepo {
  getById(id: string): Promise<Bom | undefined>;
  getByItemId(itemId: string): Promise<Bom | undefined>;
  upsertMany(boms: readonly Bom[]): Promise<void>;
}

export function bomsRepo(db: KassaDexie): BomsRepo {
  return {
    getById(id) {
      return db.boms.get(id);
    },
    getByItemId(itemId) {
      return db.boms.where("itemId").equals(itemId).first();
    },
    async upsertMany(boms) {
      if (boms.length === 0) return;
      await db.boms.bulkPut([...boms]);
    },
  };
}
