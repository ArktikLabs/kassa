import type { KassaDexie } from "./schema.ts";
import type { PendingSale } from "./types.ts";

export type NewPendingSale = Omit<
  PendingSale,
  "status" | "attempts" | "lastError" | "lastAttemptAt" | "serverSaleName" | "serverSaleId"
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
  /**
   * Recent sales for an outlet, newest first. Used by the reprint history
   * screen (KASA-220) — read-only, includes every status (queued / sending /
   * error / synced / needs_attention) because the clerk can reprint a sale
   * the moment it lands in the outbox, even if the server has not yet
   * acknowledged it.
   */
  listRecentByOutlet(outletId: string, limit?: number): Promise<PendingSale[]>;
  listAll(): Promise<PendingSale[]>;
  /** Count of outbox rows the drain still owes the server. */
  countOutstanding(): Promise<number>;
  markSending(localSaleId: string, attemptAt: string): Promise<void>;
  markError(localSaleId: string, error: string, attemptAt: string): Promise<void>;
  markNeedsAttention(localSaleId: string, error: string, attemptAt: string): Promise<void>;
  markSynced(
    localSaleId: string,
    server: { name: string | null; saleId: string | null },
    syncedAt: string,
  ): Promise<void>;
  /**
   * Flip a sale's local-row to voided. Called twice in the void lifecycle:
   * once optimistically when the cashier confirms the manager-PIN (so the
   * PEMBATALAN banner appears immediately, even offline), and once after
   * the server confirms the void on the drain (so a row that landed via
   * SW Background Sync also gets its banner).
   */
  markVoided(
    localSaleId: string,
    fields: {
      voidedAt: string;
      voidBusinessDate: string;
      voidReason: string | null;
      voidLocalId: string;
    },
  ): Promise<void>;
  /**
   * Roll back an optimistic void mark when the server later rejected the
   * void (e.g. wrong manager PIN, outside-open-shift). Only clears the
   * fields when `voidLocalId` matches `expectedVoidLocalId` — a concurrent
   * successful void from a different attempt must not be wiped.
   */
  clearOptimisticVoid(localSaleId: string, expectedVoidLocalId: string): Promise<void>;
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
        serverSaleId: null,
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
    async listRecentByOutlet(outletId, limit = 50) {
      // Dexie can't reverse a `where()` collection without a compound index, so
      // we sort ascending and slice from the tail. 50 rows is well within the
      // single-page outbox budget (KASA-122 day-bucket cap), so the in-memory
      // reverse is cheap.
      const rows = await db.pending_sales.where("outletId").equals(outletId).sortBy("createdAt");
      const newestFirst = rows.slice().reverse();
      return newestFirst.slice(0, limit);
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
    async markSynced(localSaleId, server, syncedAt) {
      const patch: Partial<PendingSale> = {
        status: "synced",
        serverSaleName: server.name,
        lastError: null,
        lastAttemptAt: syncedAt,
      };
      // Only overwrite serverSaleId when the response actually carried one.
      // The 409 idempotency replay surfaces both name + id, but a defensive
      // fallback path could land null here; keeping the prior id is safer
      // than wiping it.
      if (server.saleId !== null) patch.serverSaleId = server.saleId;
      await db.pending_sales.update(localSaleId, patch);
    },
    async markVoided(localSaleId, fields) {
      await db.pending_sales.update(localSaleId, {
        voidedAt: fields.voidedAt,
        voidBusinessDate: fields.voidBusinessDate,
        voidReason: fields.voidReason,
        voidLocalId: fields.voidLocalId,
      });
    },
    async clearOptimisticVoid(localSaleId, expectedVoidLocalId) {
      const sale = await db.pending_sales.get(localSaleId);
      if (!sale || sale.voidLocalId !== expectedVoidLocalId) return;
      await db.pending_sales.update(localSaleId, {
        voidedAt: null,
        voidBusinessDate: null,
        voidReason: null,
        voidLocalId: null,
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
