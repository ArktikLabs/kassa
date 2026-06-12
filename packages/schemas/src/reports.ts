import { z } from "zod";

/*
 * Wire schemas for `/v1/reports/cashier-day` — the back-office per-cashier
 * daily sales report (KASA-368).
 *
 * Default surface for the owner at shift handover: "what did Siti ring up
 * today, what did she void, what's her cash drawer expecting?". The endpoint
 * aggregates the (merchant, outlet, businessDate) bucket and groups by
 * `sales.clerk_id` so one row per cashier who had ≥ 1 sale that day is
 * returned. Voids are attributed to the *original* cashier on the void's
 * `voidBusinessDate`, not on the sale's `businessDate`, so the EOD variance
 * column reads the same number as `end_of_day.variance_idr` even when a void
 * straddles midnight (the same convention KASA-122 PR2 introduced for void
 * accounting).
 *
 * Money is IDR integer rupiah; date strings are merchant-local (Asia/Jakarta)
 * calendar dates (YYYY-MM-DD) matching `sales.business_date` / `eod`.
 */

const uuidV7 = z.string().uuid();
const rupiahInteger = z.number().int().nonnegative();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const cashierDayQuery = z
  .object({
    outletId: uuidV7,
    /** Inclusive single business day (Asia/Jakarta). */
    businessDate,
  })
  .strict();
export type CashierDayQuery = z.infer<typeof cashierDayQuery>;

/** Tender slice — `synthetic` rows from KASA-71 are excluded server-side. */
export const cashierDayTenderSlice = z
  .object({
    method: z.enum(["cash", "qris_dynamic", "qris_static"]),
    amountIdr: rupiahInteger,
    /** Number of tender rows of this method; useful for tie-breaks in the UI. */
    count: z.number().int().nonnegative(),
  })
  .strict();
export type CashierDayTenderSlice = z.infer<typeof cashierDayTenderSlice>;

export const cashierDayRow = z
  .object({
    cashierStaffId: uuidV7,
    /** Resolved from `staff.display_name` (or `staff.email` when missing); never empty. */
    cashierName: z.string().min(1),
    /** Non-voided sales on `businessDate`, scoped to the row's cashier and outlet. */
    saleCount: z.number().int().nonnegative(),
    /** Sum of `sales.totalIdr` for the row's non-voided sales (gross including PPN). */
    grossIdr: rupiahInteger,
    /** `grossIdr - voidIdr` — what the cashier actually banked for the day. */
    netIdr: rupiahInteger,
    /** Sales whose `voidBusinessDate` falls on the query day for this cashier. */
    voidCount: z.number().int().nonnegative(),
    /** Sum of `sales.totalIdr` for the voided slice above. */
    voidIdr: rupiahInteger,
    /** Per-method totals from non-voided sales; empty when the cashier had no sales. */
    tenderMix: z.array(cashierDayTenderSlice),
    /**
     * `opening_float + cash_sales - cash_refunds` from the matched shift row
     * (KASA-235). `null` when no shift opened for this (outlet, cashier,
     * businessDate) — pre-KASA-235 closes lack the float, so the report omits
     * the drawer column rather than guess at zero. The UI renders "—" in that
     * case and the CSV writes an empty cell.
     */
    drawerExpectedIdr: z.number().int().nullable(),
  })
  .strict();
export type CashierDayRow = z.infer<typeof cashierDayRow>;

export const cashierDayTotals = z
  .object({
    saleCount: z.number().int().nonnegative(),
    grossIdr: rupiahInteger,
    netIdr: rupiahInteger,
    voidCount: z.number().int().nonnegative(),
    voidIdr: rupiahInteger,
    tenderMix: z.array(cashierDayTenderSlice),
    /** Sum of the per-row `drawerExpectedIdr`; `null` if every row was null. */
    drawerExpectedIdr: z.number().int().nullable(),
  })
  .strict();
export type CashierDayTotals = z.infer<typeof cashierDayTotals>;

export const cashierDayResponse = z
  .object({
    outletId: uuidV7,
    businessDate,
    /** One row per cashier who had ≥ 1 sale or void on `businessDate`. */
    rows: z.array(cashierDayRow),
    /** Same shape as a row minus `cashier*` — sums across every row. */
    totals: cashierDayTotals,
  })
  .strict();
export type CashierDayResponse = z.infer<typeof cashierDayResponse>;
