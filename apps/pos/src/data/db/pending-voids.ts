import type { KassaDexie } from "./schema.ts";
import type { PendingVoid, PendingVoidStatus } from "./types.ts";

/*
 * KASA-236-B — outbox repo for the manager-PIN void flow. Mirrors the
 * `pending_sales` lifecycle: enqueue → drain → mark sending/synced/error.
 * The drain (push-voids.ts) replays the same payload until the server
 * confirms (200/201 or 409 idempotency hit) or returns a terminal 4xx
 * (mapped to `needs_attention`).
 */

export type NewPendingVoid = Omit<
  PendingVoid,
  "status" | "attempts" | "lastError" | "lastAttemptAt"
>;

export interface PendingVoidsRepo {
  enqueue(row: NewPendingVoid): Promise<PendingVoid>;
  getById(localVoidId: string): Promise<PendingVoid | undefined>;
  /** Active (not yet synced) void for a given sale, if any. */
  getActiveForSale(localSaleId: string): Promise<PendingVoid | undefined>;
  listDrainable(limit?: number): Promise<PendingVoid[]>;
  listAll(): Promise<PendingVoid[]>;
  countOutstanding(): Promise<number>;
  markSending(localVoidId: string, attemptAt: string): Promise<void>;
  markError(localVoidId: string, error: string, attemptAt: string): Promise<void>;
  markNeedsAttention(localVoidId: string, error: string, attemptAt: string): Promise<void>;
  markSynced(localVoidId: string, syncedAt: string): Promise<void>;
  /** Reset every `sending` row so the next drain retakes them after a tab kill. */
  resetInFlight(): Promise<number>;
}

export function pendingVoidsRepo(db: KassaDexie): PendingVoidsRepo {
  return {
    async enqueue(row) {
      const next: PendingVoid = {
        ...row,
        status: "queued",
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
      };
      await db.pending_voids.put(next);
      return next;
    },
    getById(localVoidId) {
      return db.pending_voids.get(localVoidId);
    },
    async getActiveForSale(localSaleId) {
      const rows = await db.pending_voids
        .where("localSaleId")
        .equals(localSaleId)
        .sortBy("createdAt");
      // Newest non-synced row wins. A clerk who retries a void after a
      // 422 should land on the latest attempt, not the original.
      const active = rows.reverse().find((r) => r.status !== "synced");
      return active;
    },
    listDrainable(limit = 50) {
      return db.pending_voids
        .where("status")
        .anyOf("queued", "error")
        .limit(limit)
        .sortBy("createdAt");
    },
    listAll() {
      return db.pending_voids.orderBy("createdAt").toArray();
    },
    countOutstanding() {
      return db.pending_voids.where("status").anyOf("queued", "sending", "error").count();
    },
    async markSending(localVoidId, attemptAt) {
      await db.pending_voids.update(localVoidId, {
        status: "sending",
        lastAttemptAt: attemptAt,
      });
    },
    async markError(localVoidId, error, attemptAt) {
      const existing = await db.pending_voids.get(localVoidId);
      if (!existing) return;
      await db.pending_voids.update(localVoidId, {
        status: "error",
        attempts: existing.attempts + 1,
        lastError: error,
        lastAttemptAt: attemptAt,
      });
    },
    async markNeedsAttention(localVoidId, error, attemptAt) {
      const existing = await db.pending_voids.get(localVoidId);
      if (!existing) return;
      await db.pending_voids.update(localVoidId, {
        status: "needs_attention",
        attempts: existing.attempts + 1,
        lastError: error,
        lastAttemptAt: attemptAt,
      });
    },
    async markSynced(localVoidId, syncedAt) {
      await db.pending_voids.update(localVoidId, {
        status: "synced",
        lastError: null,
        lastAttemptAt: syncedAt,
      });
    },
    async resetInFlight() {
      const stuck: PendingVoidStatus = "sending";
      const rows = await db.pending_voids.where("status").equals(stuck).toArray();
      for (const row of rows) {
        await db.pending_voids.update(row.localVoidId, { status: "queued" });
      }
      return rows.length;
    },
  };
}
