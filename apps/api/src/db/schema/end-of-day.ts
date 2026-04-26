import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, rupiah } from "./shared.js";
import { outlets } from "./outlets.js";
import { staff } from "./staff.js";

/**
 * End-of-day close record for a single outlet on a single business date.
 * Uniqueness on `(outlet_id, business_date)` locks the tuple so re-closing
 * the same day produces a 409, not a duplicate row (ARCHITECTURE.md §3.1
 * Flow D).
 *
 * `variance_idr` = `counted_cash_idr − expected_cash_idr`; positive is over,
 * negative is under. `variance_reason` is a free-text field the clerk fills
 * when the count does not match.
 */
export const endOfDay = pgTable(
  "end_of_day",
  {
    id: uuid("id").primaryKey(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id),
    businessDate: date("business_date").notNull(),
    closedByStaffId: uuid("closed_by_staff_id")
      .notNull()
      .references(() => staff.id),
    expectedCashIdr: rupiah("expected_cash_idr").notNull(),
    countedCashIdr: rupiah("counted_cash_idr").notNull(),
    expectedQrisIdr: rupiah("expected_qris_idr").notNull().default(0),
    varianceIdr: rupiah("variance_idr").notNull(),
    varianceReason: text("variance_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAtCol(),
  },
  (table) => ({
    outletDateUniq: uniqueIndex("end_of_day_outlet_business_date_uniq").on(
      table.outletId,
      table.businessDate,
    ),
    businessDateIdx: index("end_of_day_business_date_idx").on(table.businessDate),
  }),
);

export type EndOfDay = typeof endOfDay.$inferSelect;
export type NewEndOfDay = typeof endOfDay.$inferInsert;
