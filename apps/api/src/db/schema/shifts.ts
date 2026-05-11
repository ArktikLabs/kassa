import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, rupiah, updatedAtCol } from "./shared.js";
import { merchants } from "./merchants.js";
import { outlets } from "./outlets.js";
import { staff } from "./staff.js";

export const shiftStatusValues = ["open", "closed"] as const;
export type ShiftStatus = (typeof shiftStatusValues)[number];

/**
 * Cashier shift open/close (KASA-235).
 *
 * `open_shift_id` is the client-generated UUIDv7 the PWA stamps before the
 * row hits the offline outbox; the unique index on
 * `(merchant_id, open_shift_id)` collapses retried opens into a single
 * server row. `close_shift_id` plays the same idempotency role for the
 * close event so the two outbox kinds replay independently.
 *
 * `business_date` is the outlet-local calendar day (Asia/Jakarta in v0)
 * stamped client-side at open time and never recomputed; EOD joins shifts
 * on this column to derive `opening_float_idr`.
 *
 * `expected_cash_idr` and `variance_idr` are server-derived at close. The
 * float pre-funds the drawer so the EOD expected-cash calculation
 * (`opening_float_idr + cash_sales − cash_refunds`) stays balanced;
 * without it variance includes the float and can never hit zero — see
 * KASA-235 description.
 */
export const shifts = pgTable(
  "shifts",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id),
    cashierStaffId: uuid("cashier_staff_id")
      .notNull()
      .references(() => staff.id),
    openShiftId: uuid("open_shift_id").notNull(),
    closeShiftId: uuid("close_shift_id"),
    businessDate: date("business_date").notNull(),
    status: text("status", { enum: shiftStatusValues }).notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    openingFloatIdr: rupiah("opening_float_idr").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    countedCashIdr: rupiah("counted_cash_idr"),
    expectedCashIdr: rupiah("expected_cash_idr"),
    varianceIdr: rupiah("variance_idr"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (table) => ({
    merchantOpenShiftIdUniq: uniqueIndex("shifts_merchant_open_shift_id_uniq").on(
      table.merchantId,
      table.openShiftId,
    ),
    merchantCloseShiftIdUniq: uniqueIndex("shifts_merchant_close_shift_id_uniq").on(
      table.merchantId,
      table.closeShiftId,
    ),
    outletBusinessDateIdx: index("shifts_outlet_business_date_idx").on(
      table.outletId,
      table.businessDate,
    ),
  }),
);

export type Shift = typeof shifts.$inferSelect;
export type NewShift = typeof shifts.$inferInsert;
