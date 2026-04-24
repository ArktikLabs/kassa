import { bigint, timestamp } from "drizzle-orm/pg-core";

/**
 * Shared column helpers.
 *
 * - Rupiah columns are `bigint` (integer IDR at the storage layer, per
 *   ARCHITECTURE.md §3.2 "Money"). Drizzle's `bigint("...", { mode: "number" })`
 *   gives JS `number`, which is safe up to `2^53 − 1` — enough for any plausible
 *   single Kassa sale and all aggregates we expect in v0.
 * - `timestamptz` everywhere; the wire format is UTC ISO-8601 with explicit
 *   offset (ARCHITECTURE.md §3.2 "Time").
 */
export const rupiah = (name: string) => bigint(name, { mode: "number" });
export const createdAtCol = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const updatedAtCol = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
