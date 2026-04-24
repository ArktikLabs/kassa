import type { KassaDexie } from "./schema.ts";
import type { PendingSale } from "./types.ts";

export type NewPendingSale = Omit<
  PendingSale,
  "status" | "attempts" | "lastError" | "lastAttemptAt"
>;

export interface PendingSalesRepo {
  enqueue(sale: NewPendingSale): Promise<PendingSale>;
  getById(localSaleId: string): Promise<PendingSale | undefined>;
  listQueued(limit?: number): Promise<PendingSale[]>;
  listAll(): Promise<PendingSale[]>;
  markSending(localSaleId: string, attemptAt: string): Promise<void>;
  markError(localSaleId: string, error: string, attemptAt: string): Promise<void>;
  markDelivered(localSaleId: string): Promise<void>;
  count(): Promise<number>;
}

export function pendingSalesRepo(db: KassaDexie): PendingSalesRepo {
  return {
    async enqueue(sale) {
      const row: PendingSale = {
        ...sale,
        status: "queued",
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
      };
      // put() is an idempotent upsert keyed by localSaleId — if the client
      // retries an enqueue (offline double-tap, worker restart), we do not
      // produce a duplicate outbox entry.
      await db.pending_sales.put(row);
      return row;
    },
    getById(localSaleId) {
      return db.pending_sales.get(localSaleId);
    },
    listQueued(limit = 50) {
      return db.pending_sales
        .where("status")
        .anyOf("queued", "error")
        .limit(limit)
        .sortBy("createdAt");
    },
    listAll() {
      return db.pending_sales.orderBy("createdAt").toArray();
    },
    async markSending(localSaleId, attemptAt) {
      await db.pending_sales.update(localSaleId, {
        status: "sending",
        lastAttemptAt: attemptAt,
      });
    },
    async markError(localSaleId, error, attemptAt) {
      const existing = await db.pending_sales.get(localSaleId);
      if (!existing) return;
      await db.pending_sales.update(localSaleId, {
        status: "error",
        attempts: existing.attempts + 1,
        lastError: error,
        lastAttemptAt: attemptAt,
      });
    },
    async markDelivered(localSaleId) {
      await db.pending_sales.delete(localSaleId);
    },
    count() {
      return db.pending_sales.count();
    },
  };
}
