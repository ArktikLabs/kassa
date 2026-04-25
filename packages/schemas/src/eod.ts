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
 */
export const eodBreakdown = z
  .object({
    saleCount: z.number().int().nonnegative(),
    voidCount: z.number().int().nonnegative(),
    cashIdr: rupiahInteger,
    qrisDynamicIdr: rupiahInteger,
    qrisStaticIdr: rupiahInteger,
    cardIdr: rupiahInteger,
    otherIdr: rupiahInteger,
    netIdr: rupiahInteger,
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
    varianceIdr: rupiahSignedInteger,
    varianceReason: z.string().nullable(),
    breakdown: eodBreakdown,
  })
  .strict();
export type EodCloseResponse = z.infer<typeof eodCloseResponse>;

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
