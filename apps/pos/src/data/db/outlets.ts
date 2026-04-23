import type { KassaDexie } from "./schema.ts";
import type { Outlet } from "./types.ts";

export interface OutletsRepo {
  getById(id: string): Promise<Outlet | undefined>;
  getByCode(code: string): Promise<Outlet | undefined>;
  all(): Promise<Outlet[]>;
  upsertMany(outlets: readonly Outlet[]): Promise<void>;
}

export function outletsRepo(db: KassaDexie): OutletsRepo {
  return {
    getById(id) {
      return db.outlets.get(id);
    },
    getByCode(code) {
      return db.outlets.where("code").equals(code).first();
    },
    all() {
      return db.outlets.orderBy("code").toArray();
    },
    async upsertMany(outlets) {
      if (outlets.length === 0) return;
      await db.outlets.bulkPut([...outlets]);
    },
  };
}
