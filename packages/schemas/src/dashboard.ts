import { z } from "zod";

/*
 * Wire schemas for `/v1/reports/dashboard` — the back-office "today" tile-board
 * (KASA-237). Reused later by the v1 mobile dashboard so the JSON shape is the
 * single source of truth for both surfaces.
 *
 * The endpoint aggregates server-side over a closed `[from, to]` business-date
 * window in the merchant's local calendar (Asia/Jakarta), optionally scoped to
 * a single outlet. Money is IDR integer rupiah, consistent with the rest of
 * the API. Date strings are the same `YYYY-MM-DD` shape used by `eod` and
 * `reconciliation`.
 *
 * A query that finds zero finalised sales returns the canonical "no data"
 * shape — every total is 0 and every list is empty. The UI distinguishes that
 * from "Rp 0" by checking `saleCount === 0`.
 */

const uuidV7 = z.string().uuid();
const rupiahInteger = z.number().int().nonnegative();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const dashboardSummaryQuery = z
  .object({
    /**
     * Optional outlet scope. Owners omit it for "all outlets I manage";
     * managers either omit it or pass the single outlet they're assigned to
     * (manager-side outlet binding lands with KASA-25's session). Validated
     * against the staff principal's merchant on the server.
     */
    outletId: uuidV7.optional(),
    from: businessDate,
    to: businessDate,
  })
  .strict();
export type DashboardSummaryQuery = z.infer<typeof dashboardSummaryQuery>;

/** One slice of the tender mix; only the methods that have non-zero rows are returned. */
export const dashboardTenderSlice = z
  .object({
    method: z.enum(["cash", "qris_dynamic", "qris_static"]),
    amountIdr: rupiahInteger,
    /** Number of tender rows of this method, useful for tie-breaks in the UI. */
    count: z.number().int().nonnegative(),
  })
  .strict();
export type DashboardTenderSlice = z.infer<typeof dashboardTenderSlice>;

/** A single row in the top-items leaderboard. `revenueIdr` and `quantity` are summed across the window. */
export const dashboardItemRow = z
  .object({
    itemId: uuidV7,
    name: z.string().min(1),
    revenueIdr: rupiahInteger,
    /**
     * Sum of `sale_items.quantity`. Item lines can be fractional (`g`, `ml`),
     * so this is a number, not an integer.
     */
    quantity: z.number().nonnegative(),
  })
  .strict();
export type DashboardItemRow = z.infer<typeof dashboardItemRow>;

export const dashboardSummaryResponse = z
  .object({
    /** Echo of the resolved scope so the client can render the chip / pill. */
    outletId: uuidV7.nullable(),
    from: businessDate,
    to: businessDate,
    /**
     * Gross revenue (sum of finalised, non-synthetic, non-voided sale totals).
     * For tax-inclusive merchants this already includes PPN; `taxIdr` carries
     * the embedded amount so the UI can derive `net = gross - tax`.
     */
    grossIdr: rupiahInteger,
    /** PPN component summed across the window (KASA-218). */
    taxIdr: rupiahInteger,
    /** Net revenue: `grossIdr - taxIdr` (server-derived so the client doesn't subtract). */
    netIdr: rupiahInteger,
    /** Count of finalised, non-synthetic, non-voided sales in the window. */
    saleCount: z.number().int().nonnegative(),
    /** `round(grossIdr / saleCount)` when saleCount > 0; `0` otherwise. */
    averageTicketIdr: rupiahInteger,
    /**
     * Tender method amounts summed across the window. Empty when no sales
     * exist; methods with zero amount are omitted (tender mix is always 100%
     * of the methods that fired). The wire enum mirrors `tenders.method` —
     * `synthetic` rows from KASA-71 are excluded server-side.
     */
    tenderMix: z.array(dashboardTenderSlice),
    topItemsByRevenue: z.array(dashboardItemRow).max(5),
    topItemsByQuantity: z.array(dashboardItemRow).max(5),
  })
  .strict();
export type DashboardSummaryResponse = z.infer<typeof dashboardSummaryResponse>;
