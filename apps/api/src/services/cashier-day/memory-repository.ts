import type { CashierDayRepository } from "./repository.js";
import type {
  CashierDayInput,
  CashierDayResult,
  CashierDayRow,
  CashierDayTenderMethod,
  CashierDayTenderSlice,
} from "./types.js";

/*
 * Test / dev fake of `CashierDayRepository`.
 *
 * Carries the slice of the data model the report touches:
 *
 *  - finalised, non-synthetic sales (`status="finalised" && !synthetic`)
 *    bucketed by (merchantId, outletId, businessDate) and grouped by
 *    `clerkId` — the cashier who rang up the sale;
 *  - voids are attributed to the original cashier on `voidBusinessDate` so
 *    they roll up against the EOD variance owner (KASA-122 convention);
 *  - the shift row (KASA-235) carries the opening float used to derive
 *    `drawerExpectedIdr`.
 *
 * Filtering mirrors what the Pg variant will eventually do one-for-one so a
 * route-level test exercising this fake stays representative of production.
 */

interface SeededTender {
  method: CashierDayTenderMethod;
  amountIdr: number;
}

export interface SeededSale {
  saleId: string;
  merchantId: string;
  outletId: string;
  /** Cashier (`sales.clerk_id`) — the seat the sale was rung on. */
  cashierStaffId: string;
  /** Business day stamped at sale time. */
  businessDate: string;
  totalIdr: number;
  status: "finalised" | "voided" | "refunded" | "open";
  synthetic: boolean;
  /**
   * When non-null, the sale is treated as a void for that date — the row is
   * counted in `voidCount`/`voidIdr` for `voidBusinessDate === input.businessDate`,
   * AND removed from `saleCount`/`grossIdr`/`tenderMix` for
   * `businessDate === input.businessDate`.
   */
  voidBusinessDate: string | null;
  tenders: readonly SeededTender[];
}

export interface SeededStaff {
  staffId: string;
  merchantId: string;
  displayName: string;
}

export interface SeededShift {
  merchantId: string;
  outletId: string;
  cashierStaffId: string;
  businessDate: string;
  openingFloatIdr: number;
  /**
   * Total cash sales already netted of refunds. The cashier-day report sums
   * the per-(outlet, cashier, date) shift's `opening_float + cashNetIdr` to
   * derive `drawerExpectedIdr`. We pre-compute it here so the seed shape can
   * stay independent of refund tender attribution (which doesn't ship in
   * KASA-122 PR2 — refunds carry no tender method yet).
   */
  cashNetIdr: number;
}

export class InMemoryCashierDayRepository implements CashierDayRepository {
  private readonly sales: SeededSale[] = [];
  private readonly staffById = new Map<string, SeededStaff>();
  private readonly shifts: SeededShift[] = [];

  seedSale(sale: SeededSale): void {
    this.sales.push(sale);
  }

  seedStaff(staff: SeededStaff): void {
    this.staffById.set(staff.staffId, staff);
  }

  seedShift(shift: SeededShift): void {
    this.shifts.push(shift);
  }

  async getCashierDay(input: CashierDayInput): Promise<CashierDayResult> {
    /**
     * Pull every row that contributes to the report. Non-voided sales whose
     * `businessDate` matches roll into `gross` + `tenderMix`. Voided sales
     * whose `voidBusinessDate` matches roll into `voidCount` + `voidIdr` —
     * even when the original sale's `businessDate` doesn't (the cross-
     * midnight case KASA-122 PR2 introduced).
     */
    const inMerchant = (s: SeededSale) =>
      s.merchantId === input.merchantId && s.outletId === input.outletId && s.synthetic === false;

    type Aggregate = {
      saleCount: number;
      grossIdr: number;
      voidCount: number;
      voidIdr: number;
      tenderTotals: Map<CashierDayTenderMethod, { amountIdr: number; count: number }>;
    };

    const byCashier = new Map<string, Aggregate>();
    const ensure = (cashierStaffId: string): Aggregate => {
      let agg = byCashier.get(cashierStaffId);
      if (!agg) {
        agg = {
          saleCount: 0,
          grossIdr: 0,
          voidCount: 0,
          voidIdr: 0,
          tenderTotals: new Map(),
        };
        byCashier.set(cashierStaffId, agg);
      }
      return agg;
    };

    for (const sale of this.sales) {
      if (!inMerchant(sale)) continue;
      const isVoidThisDay =
        sale.voidBusinessDate !== null && sale.voidBusinessDate === input.businessDate;
      const isLiveThisDay =
        sale.voidBusinessDate === null &&
        sale.businessDate === input.businessDate &&
        sale.status === "finalised";

      if (!isVoidThisDay && !isLiveThisDay) continue;

      const agg = ensure(sale.cashierStaffId);
      if (isLiveThisDay) {
        agg.saleCount += 1;
        agg.grossIdr += sale.totalIdr;
        for (const t of sale.tenders) {
          const slot = agg.tenderTotals.get(t.method) ?? { amountIdr: 0, count: 0 };
          slot.amountIdr += t.amountIdr;
          slot.count += 1;
          agg.tenderTotals.set(t.method, slot);
        }
      }
      if (isVoidThisDay) {
        agg.voidCount += 1;
        agg.voidIdr += sale.totalIdr;
      }
    }

    const shiftByCashier = new Map<string, SeededShift>();
    for (const shift of this.shifts) {
      if (
        shift.merchantId === input.merchantId &&
        shift.outletId === input.outletId &&
        shift.businessDate === input.businessDate
      ) {
        shiftByCashier.set(shift.cashierStaffId, shift);
      }
    }

    const rows: CashierDayRow[] = [];
    for (const [cashierStaffId, agg] of byCashier) {
      const tenderMix: CashierDayTenderSlice[] = [...agg.tenderTotals.entries()]
        .map(([method, totals]) => ({
          method,
          amountIdr: totals.amountIdr,
          count: totals.count,
        }))
        .sort((a, b) => b.amountIdr - a.amountIdr || a.method.localeCompare(b.method));

      const staff = this.staffById.get(cashierStaffId);
      const cashierName = staff?.displayName ?? cashierStaffId;

      const shift = shiftByCashier.get(cashierStaffId);
      const drawerExpectedIdr = shift ? shift.openingFloatIdr + shift.cashNetIdr : null;

      rows.push({
        cashierStaffId,
        cashierName,
        saleCount: agg.saleCount,
        grossIdr: agg.grossIdr,
        voidCount: agg.voidCount,
        voidIdr: agg.voidIdr,
        tenderMix,
        drawerExpectedIdr,
      });
    }

    /**
     * Stable sort so the same query always returns the same row order. The
     * column owners care about first is "who banked the most today" — i.e.
     * gross descending; ties break on cashier id so the order survives a
     * cashier-by-cashier walkthrough in the back-office.
     */
    rows.sort(
      (a, b) => b.grossIdr - a.grossIdr || a.cashierStaffId.localeCompare(b.cashierStaffId),
    );

    return { rows };
  }
}
