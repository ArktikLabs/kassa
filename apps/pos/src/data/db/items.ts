import type { KassaDexie } from "./schema.ts";
import type { Item, ItemAvailability } from "./types.ts";

export interface ItemsRepo {
  getById(id: string): Promise<Item | undefined>;
  getByCode(code: string): Promise<Item | undefined>;
  search(query: string, limit?: number): Promise<Item[]>;
  listActive(limit?: number): Promise<Item[]>;
  upsertMany(items: readonly Item[]): Promise<void>;
  count(): Promise<number>;
  /**
   * KASA-248 — flip the local `availability` for one row. The catalog tile
   * calls this from its long-press sheet *before* enqueueing the outbox
   * PATCH, so the greyed state is visible inside the 200 ms optimistic
   * window. The next sync pull overwrites this with the server's
   * canonical value (the round-trip is idempotent because the field's
   * domain is two values).
   */
  setAvailability(id: string, availability: ItemAvailability): Promise<void>;
}

export function itemsRepo(db: KassaDexie): ItemsRepo {
  return {
    getById(id) {
      return db.items.get(id);
    },
    getByCode(code) {
      return db.items.where("code").equals(code).first();
    },
    async search(query, limit = 50) {
      const q = query.trim();
      if (q === "") {
        return db.items
          .orderBy("name")
          .filter((item) => item.isActive)
          .limit(limit)
          .toArray();
      }
      const byName = await db.items.where("name").startsWithIgnoreCase(q).limit(limit).toArray();
      if (byName.length >= limit) return byName;
      const byCode = await db.items
        .where("code")
        .startsWithIgnoreCase(q)
        .limit(limit - byName.length)
        .toArray();
      const seen = new Set(byName.map((item) => item.id));
      const merged: Item[] = [...byName];
      for (const item of byCode) {
        if (!seen.has(item.id)) merged.push(item);
      }
      return merged;
    },
    listActive(limit = 200) {
      return db.items
        .orderBy("name")
        .filter((item) => item.isActive)
        .limit(limit)
        .toArray();
    },
    async upsertMany(items) {
      if (items.length === 0) return;
      await db.items.bulkPut([...items]);
    },
    count() {
      return db.items.count();
    },
    async setAvailability(id, availability) {
      const row = await db.items.get(id);
      if (!row) return;
      await db.items.put({ ...row, availability });
    },
  };
}
