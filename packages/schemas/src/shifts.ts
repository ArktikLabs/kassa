import { z } from "zod";

/*
 * Wire schemas for the cashier shift open/close flow (KASA-235).
 *
 * The end-of-day reconciliation already computes variance against expected
 * cash but it currently assumes the drawer started empty. Real warungs put a
 * working float in the drawer at the start of the day, so without an open-
 * shift step that float ends up classed as variance and the v0 metric
 * "clerk closes day with zero variance" is unreachable.
 *
 * Contract:
 *   - `POST /v1/shifts/open` is idempotent on `(merchantId, openShiftId)`.
 *     A retried open with the same id returns the original row at 200; a
 *     different payload reusing the id is a 409.
 *   - `POST /v1/shifts/close` is idempotent on `(merchantId, closeShiftId)`.
 *     The close also validates the row is currently open; a second close
 *     with the same `closeShiftId` returns 200 with the existing close
 *     timestamp and breakdown.
 *   - `GET /v1/shifts/current?outletId=...` returns the still-open shift
 *     for the (merchant, outlet, cashier) bucket so the PWA can boot-
 *     resume after a tab kill / cold start.
 *
 * Money is integer rupiah, time is ISO-8601 with explicit offset, business
 * date is the outlet-local YYYY-MM-DD computed by the client at shift time.
 */

const uuidV7 = z.string().uuid();
const isoTimestamp = z.string().datetime({ offset: true });
const rupiahInteger = z.number().int().nonnegative();
/** Variance is counted − expected, so it can be negative (cash short). */
const rupiahSignedInteger = z.number().int();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const shiftStatusValues = ["open", "closed"] as const;
export type ShiftStatus = (typeof shiftStatusValues)[number];

/**
 * Canonical wire shape for a shift returned on every shift endpoint. The
 * `closed*` fields are nullable so the same shape can carry both an open
 * (count-in only) and a closed (count-in + count-out + variance) row.
 */
export const shiftRecord = z
  .object({
    shiftId: uuidV7,
    outletId: uuidV7,
    cashierStaffId: uuidV7,
    businessDate,
    status: z.enum(shiftStatusValues),
    openShiftId: uuidV7,
    openedAt: isoTimestamp,
    openingFloatIdr: rupiahInteger,
    closeShiftId: uuidV7.nullable(),
    closedAt: isoTimestamp.nullable(),
    countedCashIdr: rupiahInteger.nullable(),
    expectedCashIdr: rupiahInteger.nullable(),
    varianceIdr: rupiahSignedInteger.nullable(),
  })
  .strict();
export type ShiftRecord = z.infer<typeof shiftRecord>;

/**
 * `POST /v1/shifts/open`. The PWA generates `openShiftId` (UUIDv7) up front
 * so the offline outbox can replay safely; the same id collapses retried
 * pushes into one server row.
 */
export const shiftOpenRequest = z
  .object({
    openShiftId: uuidV7,
    outletId: uuidV7,
    cashierStaffId: uuidV7,
    businessDate,
    openedAt: isoTimestamp,
    openingFloatIdr: rupiahInteger,
  })
  .strict();
export type ShiftOpenRequest = z.infer<typeof shiftOpenRequest>;

export const shiftOpenResponse = shiftRecord;
export type ShiftOpenResponse = z.infer<typeof shiftOpenResponse>;

/**
 * `POST /v1/shifts/close`. Closing identifies the shift by its `openShiftId`
 * (the row's stable identifier) and records `countedCashIdr` against the
 * server's computed `expectedCashIdr = openingFloatIdr + cashSalesIdr`.
 * `closeShiftId` is a fresh UUIDv7 so the close itself is replay-safe.
 */
export const shiftCloseRequest = z
  .object({
    closeShiftId: uuidV7,
    openShiftId: uuidV7,
    closedAt: isoTimestamp,
    countedCashIdr: rupiahInteger,
  })
  .strict();
export type ShiftCloseRequest = z.infer<typeof shiftCloseRequest>;

export const shiftCloseResponse = shiftRecord;
export type ShiftCloseResponse = z.infer<typeof shiftCloseResponse>;

/**
 * `GET /v1/shifts/current?outletId=...&cashierStaffId=...`. Resolves the
 * (merchant, outlet, cashier) bucket's still-open shift, or 404 when no
 * open shift exists. The PWA hits this on cold start to decide whether to
 * route the cashier to `/shift/open` or straight to `/catalog`.
 */
export const shiftCurrentQuery = z
  .object({
    outletId: uuidV7,
    cashierStaffId: uuidV7,
  })
  .strict();
export type ShiftCurrentQuery = z.infer<typeof shiftCurrentQuery>;

export const shiftCurrentResponse = shiftRecord;
export type ShiftCurrentResponse = z.infer<typeof shiftCurrentResponse>;
