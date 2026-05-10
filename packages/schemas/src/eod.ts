import { z } from "zod";

/*
 * Wire schemas for the end-of-day close flow (ARCHITECTURE.md §3.1 Flow D).
 *
 * EOD is the one flow that is explicitly ordered against sale submit:
 *   1. client drains its pending_sales outbox
 *   2. client collects every local_sale_id it intends to include and POSTs
 *      `/v1/eod/close` with the counted cash
 *   3. server verifies every id is present, creates the `end_of_day` row,
 *      locks (outlet, business_date) so no more sales can be created for
 *      that date, and returns the canonical breakdown
 *
 * Money is IDR integer minor units (rupiah), same as the rest of the API.
 * `businessDate` is the merchant-local calendar date in YYYY-MM-DD, not a
 * UTC instant; the outlet's timezone is applied client-side at the time of
 * sale (`features/sale.finalize.ts`) and the server buckets on that bucket.
 */

const uuidV7 = z.string().uuid();
const rupiahInteger = z.number().int().nonnegative();
/** Variance is counted − expected, so it can be negative (cash short). */
const rupiahSignedInteger = z.number().int();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const eodCloseRequest = z
  .object({
    outletId: uuidV7,
    businessDate,
    countedCashIdr: rupiahInteger,
    /**
     * Free-text reason the clerk entered. Required when variance != 0; the
     * server rejects a non-zero-variance close without a reason. Nullable
     * because the happy-path zero-variance close has no reason to attach.
     */
    varianceReason: z.string().min(1).max(500).nullable(),
    /**
     * The complete list of `local_sale_id`s the client considers final for
     * this (outlet, businessDate). Must include every sale the outbox has
     * pushed in the current session. The server cross-checks against its
     * own `sale` rows; if any id is missing it returns 409 with the
     * `missingSaleIds` list so the PWA can re-queue them.
     */
    clientSaleIds: z.array(uuidV7).max(10_000),
  })
  .strict();
export type EodCloseRequest = z.infer<typeof eodCloseRequest>;

/**
 * Canonical tender breakdown returned on close. The classification of QRIS
 * dynamic vs static is the server's responsibility — the client outbox only
 * knows `qris` — so dynamic/static are flat-zero until the payments
 * reconciliation worker (KASA-74) is wired. For now the server places every
 * QRIS amount under `qrisStaticIdr` so the "unverified" line is truthful.
 *
 * `qrisStaticUnverifiedIdr` is a subset of `qrisStaticIdr` covering the
 * tenders the EOD reconciliation pass (KASA-64) hasn't paired with a
 * Midtrans settlement row yet. It is the variance-risk number the clerk
 * sees at close time: real money the server cannot yet vouch for.
 *
 * `qrisStaticUnverifiedCount` is the number of unverified static-QRIS
 * tenders behind that amount; back-office uses it to badge how many
 * rows the operator must manually reconcile (KASA-197 AC).
 */
export const eodBreakdown = z
  .object({
    saleCount: z.number().int().nonnegative(),
    voidCount: z.number().int().nonnegative(),
    cashIdr: rupiahInteger,
    qrisDynamicIdr: rupiahInteger,
    qrisStaticIdr: rupiahInteger,
    qrisStaticUnverifiedIdr: rupiahInteger,
    qrisStaticUnverifiedCount: z.number().int().nonnegative(),
    cardIdr: rupiahInteger,
    otherIdr: rupiahInteger,
    netIdr: rupiahInteger,
    /**
     * KASA-218 — sum of `sale.taxIdr` across every non-voided sale included
     * in this close. For an inclusive merchant this is the PPN component
     * already embedded in `netIdr`; for an exclusive merchant it sits on top
     * (still summed independently here so the close screen and back-office
     * can break it out without re-walking the sale list).
     */
    taxIdr: rupiahInteger,
  })
  .strict();
export type EodBreakdown = z.infer<typeof eodBreakdown>;

export const eodCloseResponse = z
  .object({
    eodId: uuidV7,
    outletId: uuidV7,
    businessDate,
    closedAt: z.string().datetime({ offset: true }),
    countedCashIdr: rupiahInteger,
    expectedCashIdr: rupiahInteger,
    /**
     * KASA-235 — starting cash float recorded against the day's open
     * shift. Folded into `expectedCashIdr` so the variance never
     * includes the float; surfaced separately so back-office can
     * render the open/close tape without joining the shifts table.
     * Defaults to 0 so pre-KASA-235 servers and days that never opened
     * a shift remain wire-compatible.
     */
    openingFloatIdr: rupiahInteger.default(0),
    varianceIdr: rupiahSignedInteger,
    varianceReason: z.string().nullable(),
    breakdown: eodBreakdown,
  })
  .strict();
export type EodCloseResponse = z.infer<typeof eodCloseResponse>;

/**
 * Path parameter for `GET /v1/eod/:eodId`. Lives here so the contract
 * gate (KASA-179) can trace the route's params back to a `@kassa/schemas`
 * export.
 */
export const eodIdParam = z.object({ eodId: uuidV7 }).strict();
export type EodIdParam = z.infer<typeof eodIdParam>;

/**
 * Read shape returned by `GET /v1/eod/:eodId`. Identical to the close
 * response so back-office can re-render an existing close screen straight
 * from a fetch — the breakdown (including `qrisStaticUnverifiedCount`,
 * KASA-197 AC) is the same wire object.
 */
export const eodGetResponse = eodCloseResponse;
export type EodGetResponse = z.infer<typeof eodGetResponse>;

/**
 * Details attached to the 409 `eod_sale_mismatch` error. The receive/expected
 * counts are redundant with `missingSaleIds.length` but let the PWA render
 * `Kurang N dari M sinkronisasi` without recomputing.
 */
export const eodMissingSalesDetails = z
  .object({
    expectedCount: z.number().int().nonnegative(),
    receivedCount: z.number().int().nonnegative(),
    missingSaleIds: z.array(uuidV7),
  })
  .strict();
export type EodMissingSalesDetails = z.infer<typeof eodMissingSalesDetails>;
