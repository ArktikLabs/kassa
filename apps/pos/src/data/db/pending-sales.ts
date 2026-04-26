import type { KassaDexie } from "./schema.ts";
import type { PendingSale } from "./types.ts";

export type NewPendingSale = Omit<
  PendingSale,
  "status" | "attempts" | "lastError" | "lastAttemptAt" | "serverSaleName"
>;

export type OutboxRetriableStatus = Extract<PendingSale["status"], "queued" | "error">;

export interface PendingSalesRepo {
  enqueue(sale: NewPendingSale): Promise<PendingSale>;
  getById(localSaleId: string): Promise<PendingSale | undefined>;
  /**
   * Rows the drain may pick up this cycle: `queued` and `error` (i.e.
   * retriable). `sending` is excluded because it belongs to an in-flight
   * attempt; `needs_attention`/`synced` are terminal for the drain loop.
   */
  listDrainable(limit?: number): Promise<PendingSale[]>;
  /** Same contract as listDrainable, kept for backwards-compat call sites. */
  listQueued(limit?: number): Promise<PendingSale[]>;
  listNeedsAttention(): Promise<PendingSale[]>;
  listAll(): Promise<PendingSale[]>;
  /** Count of outbox rows the drain still owes the server. */
  countOutstanding(): Promise<number>;
  markSending(localSaleId: string, attemptAt: string): Promise<void>;
  markError(localSaleId: string, error: string, attemptAt: string): Promise<void>;
  markNeedsAttention(localSaleId: string, error: string, attemptAt: string): Promise<void>;
  markSynced(localSaleId: string, serverSaleName: string | null, syncedAt: string): Promise<void>;
  /**
   * Move a row back into the drain. Used on app boot (reset `sending` → `queued`)
   * and by the "Coba kirim ulang" admin action (reset `needs_attention` → `queued`).
   */
  requeue(localSaleId: string): Promise<void>;
  /** Reset all in-flight rows so the drain retakes them after a crash/tab death. */
  resetInFlight(): Promise<number>;
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
        serverSaleName: null,
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
    listDrainable(limit = 50) {
      return db.pending_sales
        .where("status")
        .anyOf("queued", "error")
        .limit(limit)
        .sortBy("createdAt");
    },
    listQueued(limit = 50) {
      return db.pending_sales
        .where("status")
        .anyOf("queued", "error")
        .limit(limit)
        .sortBy("createdAt");
    },
    listNeedsAttention() {
      return db.pending_sales.where("status").equals("needs_attention").sortBy("createdAt");
    },
    listAll() {
      return db.pending_sales.orderBy("createdAt").toArray();
    },
    countOutstanding() {
      return db.pending_sales.where("status").anyOf("queued", "sending", "error").count();
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
    async markNeedsAttention(localSaleId, error, attemptAt) {
      const existing = await db.pending_sales.get(localSaleId);
      if (!existing) return;
      await db.pending_sales.update(localSaleId, {
        status: "needs_attention",
        attempts: existing.attempts + 1,
        lastError: error,
        lastAttemptAt: attemptAt,
      });
    },
    async markSynced(localSaleId, serverSaleName, syncedAt) {
      await db.pending_sales.update(localSaleId, {
        status: "synced",
        serverSaleName,
        lastError: null,
        lastAttemptAt: syncedAt,
      });
    },
    async requeue(localSaleId) {
      await db.pending_sales.update(localSaleId, {
        status: "queued",
        lastError: null,
      });
    },
    async resetInFlight() {
      return db.pending_sales.where("status").equals("sending").modify({ status: "queued" });
    },
    count() {
      return db.pending_sales.count();
    },
  };
}
