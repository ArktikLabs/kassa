import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { devices } from "./devices.js";

/**
 * Diagnostic trail of client pushes and reference pulls — the ops "what did
 * device X send, and when did I respond" view. Not authoritative; if this
 * table is truncated no money or stock moves. A BullMQ cron purges rows
 * older than 30 days (ARCHITECTURE.md §3.2).
 */
export const syncLog = pgTable(
  "sync_log",
  {
    id: uuid("id").primaryKey(),
    deviceId: uuid("device_id").references(() => devices.id),
    requestId: text("request_id"),
    endpoint: text("endpoint").notNull(),
    method: text("method").notNull(),
    statusCode: integer("status_code").notNull(),
    durationMs: integer("duration_ms"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Purge cron scan path.
    createdAtIdx: index("sync_log_created_at_idx").on(table.createdAt),
    deviceIdx: index("sync_log_device_idx").on(table.deviceId),
  }),
);

export type SyncLogRow = typeof syncLog.$inferSelect;
export type NewSyncLogRow = typeof syncLog.$inferInsert;
