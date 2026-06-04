import { z } from "zod";

/*
 * Wire schemas for `GET /v1/admin/sales/summary` (KASA-327).
 *
 * Period-summary aggregator that drives the back-office "Ringkasan periode"
 * panel + the monthly CSV / PDF export an Indonesian merchant hands to their
 * accountant for PPh / PPN reporting. Reuses the same `sales` rows the
 * KASA-237 dashboard reads from — discounts, PPN (KASA-218), voids
 * (KASA-236), tender mix — but lets the caller pick the bucket axis
 * (`groupBy=day | outlet | tender | item`) and returns more pickable
 * bookkeeping fields than the today-tile view.
 *
 * Date range is closed `[from, to]` on `sales.business_date` in the
 * merchant's local calendar (Asia/Jakarta). The 92-day cap and `from <= to`
 * check are enforced server-side in the service layer so the wire format
 * stays a simple `YYYY-MM-DD` string — the route returns
 * `400 range_too_large` for overlong windows rather than failing zod here.
 */

const uuidV7 = z.string().uuid();
const rupiahInteger = z.number().int().nonnegative();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const salesSummaryGroupBy = z.enum(["day", "outlet", "tender", "item"]);
export type SalesSummaryGroupBy = z.infer<typeof salesSummaryGroupBy>;

export const salesSummaryQuery = z
  .object({
    /** Optional outlet scope. Omit for the cross-outlet rollup. */
    outletId: uuidV7.optional(),
    from: businessDate,
    to: businessDate,
    groupBy: salesSummaryGroupBy,
  })
  .strict();
export type SalesSummaryQuery = z.infer<typeof salesSummaryQuery>;

/** Tender amount slice across the window; the headline mix on the response. */
export const salesSummaryTenderSlice = z
  .object({
    method: z.enum(["cash", "qris_dynamic", "qris_static"]),
    amountIdr: rupiahInteger,
    /** Number of tender rows of this method, useful for tie-breaks in the UI. */
    count: z.number().int().nonnegative(),
  })
  .strict();
export type SalesSummaryTenderSlice = z.infer<typeof salesSummaryTenderSlice>;

/** A single row in the top-items leaderboards. */
export const salesSummaryItemRow = z
  .object({
    itemId: uuidV7,
    name: z.string().min(1),
    revenueIdr: rupiahInteger,
    /** Item lines can be fractional (`g`, `ml`), so this is a number, not an integer. */
    quantity: z.number().nonnegative(),
  })
  .strict();
export type SalesSummaryItemRow = z.infer<typeof salesSummaryItemRow>;

/**
 * One bucket of the breakdown picked by `groupBy`. Shape is uniform across
 * modes so the CSV writer doesn't need to fork. Fields that don't apply to
 * a given mode are zero / empty:
 *
 *   - `groupBy=day`: `key` is `YYYY-MM-DD`, money fields populated.
 *   - `groupBy=outlet`: `key` is the outlet UUID, money fields populated.
 *     The API does not look up the outlet display name — the back-office
 *     joins by id against its already-fetched outlet list. `label` echoes
 *     `key` so the wire row stays self-describing.
 *   - `groupBy=tender`: `key` is the tender method (`cash` / `qris_dynamic`
 *     / `qris_static`), `grossIdr` is the tender amount, `saleCount` is
 *     the count of tender rows. Discount / tax / refund are zero because
 *     those live on the sale, not on the tender.
 *   - `groupBy=item`: `key` is the item UUID, `label` is the item name,
 *     `grossIdr` is line-total revenue, `quantity` is sum of `sale_items.quantity`.
 *     Discount / tax / refund are zero for item buckets — those are
 *     sale-level totals that don't reasonably decompose per item without
 *     a tax-allocation pass we're explicitly out-of-scoping here.
 */
export const salesSummaryGroupRow = z
  .object({
    key: z.string().min(1),
    label: z.string(),
    grossIdr: rupiahInteger,
    discountIdr: rupiahInteger,
    taxIdr: rupiahInteger,
    netIdr: rupiahInteger,
    saleCount: z.number().int().nonnegative(),
    /** Number of voided sales attributed to this bucket. */
    refundCount: z.number().int().nonnegative(),
    /** Sum of voided-sale totals attributed to this bucket. */
    refundIdr: rupiahInteger,
    /** Only meaningful for `groupBy=item`; 0 elsewhere. */
    quantity: z.number().nonnegative(),
  })
  .strict();
export type SalesSummaryGroupRow = z.infer<typeof salesSummaryGroupRow>;

export const salesSummaryResponse = z
  .object({
    outletId: uuidV7.nullable(),
    from: businessDate,
    to: businessDate,
    groupBy: salesSummaryGroupBy,
    /** Gross revenue across finalised, non-synthetic, non-voided sales. */
    grossIdr: rupiahInteger,
    /** Sum of `sales.discount_idr` across the same set. */
    discountIdr: rupiahInteger,
    /** PPN component summed across the window (KASA-218). */
    taxIdr: rupiahInteger,
    /** Net revenue: `grossIdr - taxIdr` (server-derived). */
    netIdr: rupiahInteger,
    /** Count of finalised, non-synthetic, non-voided sales. */
    saleCount: z.number().int().nonnegative(),
    /** Count of voided sales in the window (KASA-236). */
    refundCount: z.number().int().nonnegative(),
    /** Sum of voided-sale totals in the window. */
    refundIdr: rupiahInteger,
    /** Tender method amounts summed across the window. */
    tenderMix: z.array(salesSummaryTenderSlice),
    /** Top 10 items by line revenue across the window. */
    topItemsByRevenue: z.array(salesSummaryItemRow).max(10),
    /** Top 10 items by line quantity across the window. */
    topItemsByQuantity: z.array(salesSummaryItemRow).max(10),
    /** One row per `groupBy` bucket; the CSV/PDF export maps 1:1 from this list. */
    groups: z.array(salesSummaryGroupRow),
  })
  .strict();
export type SalesSummaryResponse = z.infer<typeof salesSummaryResponse>;

/** Inclusive maximum length of `[from, to]` in days. Service returns 400 beyond this. */
export const SALES_SUMMARY_MAX_RANGE_DAYS = 92;

/** Maximum rows returned in either top-items leaderboard. Matches the response cap. */
export const SALES_SUMMARY_TOP_ITEMS_LIMIT = 10;
