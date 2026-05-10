import { uuidv7 } from "../../lib/uuid.js";
import type { SalesReader } from "../eod/repository.js";
import type { ShiftsRepository } from "./repository.js";
import type { ShiftRecord } from "./types.js";

/*
 * Cashier shift open/close service (KASA-235).
 *
 * The service is the single place that enforces:
 *   - `(merchantId, openShiftId)` is the open-event idempotency key — a
 *     replayed open with the same payload returns the existing row at
 *     200; a different payload reusing the id is `shift_idempotency_conflict`
 *     (rendered as 409 by the route).
 *   - `(merchantId, closeShiftId)` is the close-event idempotency key —
 *     replays return the existing closed row at 200.
 *   - close validates the row is currently open AND that `expectedCashIdr`
 *     and `varianceIdr` are derived server-side from the cash-sale tape.
 *
 * The expected-cash math here mirrors the EOD service's own reducer
 * (`computeExpectedCash`): `openingFloatIdr + cashSalesIdr − cashRefundsIdr`.
 * Refunds are out of scope until KASA-236, so the close currently sums
 * cash sales for the (outlet, businessDate) and adds the float on top.
 */

export type ShiftErrorCode =
  | "shift_idempotency_conflict"
  | "shift_close_idempotency_conflict"
  | "shift_not_open"
  | "shift_not_found";

export class ShiftError extends Error {
  constructor(
    readonly code: ShiftErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ShiftError";
  }
}

export interface ShiftsServiceDeps {
  repository: ShiftsRepository;
  salesReader: SalesReader;
  now?: () => Date;
  generateShiftId?: () => string;
}

export interface OpenShiftInput {
  merchantId: string;
  openShiftId: string;
  outletId: string;
  cashierStaffId: string;
  businessDate: string;
  openedAt: string;
  openingFloatIdr: number;
}

export interface CloseShiftInput {
  merchantId: string;
  closeShiftId: string;
  openShiftId: string;
  closedAt: string;
  countedCashIdr: number;
}

export interface CurrentShiftInput {
  merchantId: string;
  outletId: string;
  cashierStaffId: string;
}

export class ShiftsService {
  private readonly repository: ShiftsRepository;
  private readonly salesReader: SalesReader;
  private readonly now: () => Date;
  private readonly generateShiftId: () => string;

  constructor(deps: ShiftsServiceDeps) {
    this.repository = deps.repository;
    this.salesReader = deps.salesReader;
    this.now = deps.now ?? (() => new Date());
    this.generateShiftId = deps.generateShiftId ?? uuidv7;
  }

  async open(input: OpenShiftInput): Promise<ShiftRecord> {
    const existing = await this.repository.findByOpenShiftId({
      merchantId: input.merchantId,
      openShiftId: input.openShiftId,
    });
    if (existing) {
      // Idempotency: the same payload replayed against the same openShiftId
      // returns the originally stored row. A different payload reusing the
      // id is a conflict — the client outbox must not reuse open ids
      // between distinct shift opens.
      if (
        existing.outletId !== input.outletId ||
        existing.cashierStaffId !== input.cashierStaffId ||
        existing.openingFloatIdr !== input.openingFloatIdr ||
        existing.businessDate !== input.businessDate
      ) {
        throw new ShiftError(
          "shift_idempotency_conflict",
          `Shift ${input.openShiftId} already exists with a different payload.`,
        );
      }
      return existing;
    }
    const record: ShiftRecord = {
      id: this.generateShiftId(),
      merchantId: input.merchantId,
      outletId: input.outletId,
      cashierStaffId: input.cashierStaffId,
      businessDate: input.businessDate,
      status: "open",
      openShiftId: input.openShiftId,
      openedAt: input.openedAt,
      openingFloatIdr: input.openingFloatIdr,
      closeShiftId: null,
      closedAt: null,
      countedCashIdr: null,
      expectedCashIdr: null,
      varianceIdr: null,
    };
    return this.repository.insertOpen(record);
  }

  async close(input: CloseShiftInput): Promise<ShiftRecord> {
    // Close is idempotent on `closeShiftId`: a retried close that already
    // landed earlier returns the existing closed row (status="closed").
    const closedAlready = await this.repository.findByCloseShiftId({
      merchantId: input.merchantId,
      closeShiftId: input.closeShiftId,
    });
    if (closedAlready) {
      if (closedAlready.openShiftId !== input.openShiftId) {
        throw new ShiftError(
          "shift_close_idempotency_conflict",
          `closeShiftId ${input.closeShiftId} is bound to a different open shift.`,
        );
      }
      return closedAlready;
    }

    const open = await this.repository.findByOpenShiftId({
      merchantId: input.merchantId,
      openShiftId: input.openShiftId,
    });
    if (!open) {
      throw new ShiftError(
        "shift_not_found",
        `No shift exists for openShiftId ${input.openShiftId}.`,
      );
    }
    if (open.status === "closed") {
      // The row is already closed but `closeShiftId` does not match the
      // recorded one — a stale close attempt against a previously closed
      // shift. Return 409 so the client can drop the stale outbox row.
      throw new ShiftError("shift_not_open", `Shift ${input.openShiftId} is already closed.`);
    }

    const cashSalesIdr = await this.computeCashSales({
      merchantId: input.merchantId,
      outletId: open.outletId,
      businessDate: open.businessDate,
    });
    const expectedCashIdr = open.openingFloatIdr + cashSalesIdr;
    const varianceIdr = input.countedCashIdr - expectedCashIdr;

    return this.repository.recordClose({
      merchantId: input.merchantId,
      openShiftId: input.openShiftId,
      closeShiftId: input.closeShiftId,
      closedAt: input.closedAt,
      countedCashIdr: input.countedCashIdr,
      expectedCashIdr,
      varianceIdr,
    });
  }

  async current(input: CurrentShiftInput): Promise<ShiftRecord | null> {
    return this.repository.findOpenShiftForCashier(input);
  }

  /**
   * Sum the non-voided cash tenders bucketed to (merchant, outlet,
   * businessDate). Mirrors the EOD service's `computeExpectedCash` so the
   * shift close and the EOD close land on the same number.
   */
  private async computeCashSales(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<number> {
    const sales = await this.salesReader.listSalesByBusinessDate(input);
    let total = 0;
    for (const sale of sales) {
      if (sale.voidedAt !== null) continue;
      if (sale.synthetic) continue;
      for (const tender of sale.tenders) {
        if (tender.method === "cash") total += tender.amountIdr;
      }
    }
    return total;
  }
}
