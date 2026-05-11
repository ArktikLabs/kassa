import type { ShiftRecord } from "./types.js";

/*
 * Storage contract for cashier shifts (KASA-235).
 *
 * Two idempotency keys ride on every shift row: `openShiftId` keys the
 * open event and `closeShiftId` keys the close event. The unique indexes
 * `(merchantId, openShiftId)` and `(merchantId, closeShiftId)` collapse
 * retried outbox pushes into a single server row.
 *
 * The EOD service reads shifts through a narrow port (`ShiftReader`) so it
 * can fetch the float for a given (outlet, businessDate) without coupling
 * to the full `ShiftsRepository` surface.
 */

export interface ShiftReader {
  /**
   * Most recent shift opened on the (merchant, outlet, businessDate)
   * tuple, or null when no shift was opened that day. EOD pulls this to
   * derive `openingFloatIdr` for the expected-cash calculation; v0 ships
   * single-cashier-per-outlet so a single result is correct. Multi-
   * cashier handoff (one outlet, multiple shifts in a day) is explicitly
   * out of scope per the KASA-235 description.
   */
  findShiftForBusinessDate(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<ShiftRecord | null>;
}

export interface ShiftsRepository extends ShiftReader {
  /**
   * Resolve a shift by its client-generated `openShiftId` so the open
   * route can answer 200 idempotently on a retried push. Returns null
   * when the id is unknown OR belongs to a different merchant — the
   * route maps that to an "insert" path so cross-tenant ids never
   * resolve to another merchant's row.
   */
  findByOpenShiftId(input: {
    merchantId: string;
    openShiftId: string;
  }): Promise<ShiftRecord | null>;
  /**
   * Resolve a shift by its `closeShiftId` so the close route can answer
   * 200 idempotently on a retried close — even after the original open
   * row has been mutated to `status="closed"`.
   */
  findByCloseShiftId(input: {
    merchantId: string;
    closeShiftId: string;
  }): Promise<ShiftRecord | null>;
  /**
   * Currently-open shift for the (merchant, outlet, cashier) bucket. The
   * PWA hits this on cold start to decide between `/shift/open` and
   * `/catalog`; the route returns 404 when no open shift exists so the
   * client can route deterministically.
   */
  findOpenShiftForCashier(input: {
    merchantId: string;
    outletId: string;
    cashierStaffId: string;
  }): Promise<ShiftRecord | null>;
  /**
   * KASA-236-A — the (merchant, outlet)'s currently-open shift (any
   * cashier). The sales `void` route consults this to enforce the rule
   * that only sales from the open shift's `businessDate` can be voided
   * via the POS path; prior-shift corrections route through the back-
   * office reconciliation flow (KASA-119). v0 ships single-cashier-per-
   * outlet so the "any cashier" qualifier is moot; this signature keeps
   * the contract honest for the multi-cashier follow-up.
   */
  findOpenShiftForOutlet(input: {
    merchantId: string;
    outletId: string;
  }): Promise<ShiftRecord | null>;
  insertOpen(record: ShiftRecord): Promise<ShiftRecord>;
  /**
   * Stamp the close fields on an existing open row. Implementations must
   * fail loudly if the row is already closed so the service can map a
   * mismatched `(openShiftId, closeShiftId)` pair to a 409 instead of
   * silently overwriting the prior close.
   */
  recordClose(input: {
    openShiftId: string;
    merchantId: string;
    closeShiftId: string;
    closedAt: string;
    countedCashIdr: number;
    expectedCashIdr: number;
    varianceIdr: number;
  }): Promise<ShiftRecord>;
}
