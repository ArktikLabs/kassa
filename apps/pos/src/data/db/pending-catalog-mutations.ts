import type { KassaDexie } from "./schema.ts";
import type { ItemAvailability, PendingCatalogMutation } from "./types.ts";

/**
 * Outbox repo for the catalog tile's long-press availability toggle
 * (KASA-248). Rows are keyed by `itemId` so a flip-flop on the same
 * tile collapses to the latest desired state rather than queueing two
 * opposite PATCHes that would race.
 *
 * The drain function lives in `data/sync/push-catalog.ts`; this repo is
 * the pure data plane. Status transitions mirror the pending-sales
 * outbox (KASA-62) so the offline-buffered HTTP behaviour stays uniform
 * across resources.
 */
export interface PendingCatalogMutationsRepo {
  /**
   * Set the desired availability for an item. Collapses any queued/error
   * row for the same `itemId` into the new state; if a `sending` row
   * exists we still overwrite (the in-flight request may already have
   * shipped the old value, but the drain treats this row as the
   * authoritative next intent and replays).
   */
  enqueue(input: {
    itemId: string;
    availability: ItemAvailability;
    createdAt: string;
  }): Promise<PendingCatalogMutation>;
  getById(itemId: string): Promise<PendingCatalogMutation | undefined>;
  listDrainable(limit?: number): Promise<PendingCatalogMutation[]>;
  listAll(): Promise<PendingCatalogMutation[]>;
  countOutstanding(): Promise<number>;
  markSending(itemId: string, attemptAt: string): Promise<void>;
  markError(itemId: string, error: string, attemptAt: string): Promise<void>;
  markNeedsAttention(itemId: string, error: string, attemptAt: string): Promise<void>;
  /** Terminal success — drop the row. Server is now the source of truth. */
  markSynced(itemId: string): Promise<void>;
  resetInFlight(): Promise<number>;
}

export function pendingCatalogMutationsRepo(db: KassaDexie): PendingCatalogMutationsRepo {
  return {
    async enqueue({ itemId, availability, createdAt }) {
      const row: PendingCatalogMutation = {
        itemId,
        availability,
        status: "queued",
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
        createdAt,
      };
      await db.pending_catalog_mutations.put(row);
      return row;
    },
    getById(itemId) {
      return db.pending_catalog_mutations.get(itemId);
    },
    listDrainable(limit = 50) {
      return db.pending_catalog_mutations
        .where("status")
        .anyOf("queued", "error")
        .limit(limit)
        .sortBy("createdAt");
    },
    listAll() {
      return db.pending_catalog_mutations.orderBy("createdAt").toArray();
    },
    countOutstanding() {
      return db.pending_catalog_mutations
        .where("status")
        .anyOf("queued", "sending", "error")
        .count();
    },
    async markSending(itemId, attemptAt) {
      const row = await db.pending_catalog_mutations.get(itemId);
      if (!row) return;
      await db.pending_catalog_mutations.put({
        ...row,
        status: "sending",
        attempts: row.attempts + 1,
        lastAttemptAt: attemptAt,
      });
    },
    async markError(itemId, error, attemptAt) {
      const row = await db.pending_catalog_mutations.get(itemId);
      if (!row) return;
      await db.pending_catalog_mutations.put({
        ...row,
        status: "error",
        lastError: error,
        lastAttemptAt: attemptAt,
      });
    },
    async markNeedsAttention(itemId, error, attemptAt) {
      const row = await db.pending_catalog_mutations.get(itemId);
      if (!row) return;
      await db.pending_catalog_mutations.put({
        ...row,
        status: "needs_attention",
        lastError: error,
        lastAttemptAt: attemptAt,
      });
    },
    async markSynced(itemId) {
      await db.pending_catalog_mutations.delete(itemId);
    },
    async resetInFlight() {
      const stuck = await db.pending_catalog_mutations.where("status").equals("sending").toArray();
      if (stuck.length === 0) return 0;
      await db.pending_catalog_mutations.bulkPut(
        stuck.map((row) => ({ ...row, status: "queued" as const })),
      );
      return stuck.length;
    },
  };
}
