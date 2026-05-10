import type { KassaDexie } from "./schema.ts";
import type { PendingShiftEvent, PendingShiftEventStatus } from "./types.ts";

export type NewPendingShiftEvent = Omit<
  PendingShiftEvent,
  "status" | "attempts" | "lastError" | "lastAttemptAt"
>;

export interface PendingShiftEventsRepo {
  enqueue(event: NewPendingShiftEvent): Promise<PendingShiftEvent>;
  getById(eventId: string): Promise<PendingShiftEvent | undefined>;
  /** Rows the drain may pick up this cycle: `queued` and `error`. */
  listDrainable(limit?: number): Promise<PendingShiftEvent[]>;
  listAll(): Promise<PendingShiftEvent[]>;
  countOutstanding(): Promise<number>;
  markSending(eventId: string, attemptAt: string): Promise<void>;
  markError(eventId: string, error: string, attemptAt: string): Promise<void>;
  markNeedsAttention(eventId: string, error: string, attemptAt: string): Promise<void>;
  markSynced(eventId: string, syncedAt: string): Promise<void>;
  /** Reset every `sending` row so the next drain retakes them after a tab kill. */
  resetInFlight(): Promise<number>;
}

export function pendingShiftEventsRepo(db: KassaDexie): PendingShiftEventsRepo {
  return {
    async enqueue(event) {
      const row: PendingShiftEvent = {
        ...event,
        status: "queued",
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
      };
      await db.pending_shift_events.put(row);
      return row;
    },
    getById(eventId) {
      return db.pending_shift_events.get(eventId);
    },
    listDrainable(limit = 50) {
      return db.pending_shift_events
        .where("status")
        .anyOf("queued", "error")
        .limit(limit)
        .sortBy("createdAt");
    },
    listAll() {
      return db.pending_shift_events.orderBy("createdAt").toArray();
    },
    countOutstanding() {
      return db.pending_shift_events.where("status").anyOf("queued", "sending", "error").count();
    },
    async markSending(eventId, attemptAt) {
      await db.pending_shift_events.update(eventId, {
        status: "sending",
        lastAttemptAt: attemptAt,
      });
    },
    async markError(eventId, error, attemptAt) {
      const existing = await db.pending_shift_events.get(eventId);
      if (!existing) return;
      await db.pending_shift_events.update(eventId, {
        status: "error",
        attempts: existing.attempts + 1,
        lastError: error,
        lastAttemptAt: attemptAt,
      });
    },
    async markNeedsAttention(eventId, error, attemptAt) {
      const existing = await db.pending_shift_events.get(eventId);
      if (!existing) return;
      await db.pending_shift_events.update(eventId, {
        status: "needs_attention",
        attempts: existing.attempts + 1,
        lastError: error,
        lastAttemptAt: attemptAt,
      });
    },
    async markSynced(eventId, syncedAt) {
      await db.pending_shift_events.update(eventId, {
        status: "synced",
        lastError: null,
        lastAttemptAt: syncedAt,
      });
    },
    async resetInFlight() {
      const stuck: PendingShiftEventStatus = "sending";
      const rows = await db.pending_shift_events.where("status").equals(stuck).toArray();
      for (const row of rows) {
        await db.pending_shift_events.update(row.eventId, {
          status: "queued",
        });
      }
      return rows.length;
    },
  };
}
