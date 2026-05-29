/*
 * Domain types for the per-cashier daily sales aggregator (KASA-368).
 *
 * Mirrors the `cashierDayResponse` Zod schema but speaks `number` rather than
 * branded amount types so the in-memory and Pg repositories can share one
 * shape. Money is integer rupiah; the date is the merchant-local
 * (Asia/Jakarta) calendar day stamped on `sales.business_date` and
 * `sales.void_business_date`.
 */

export interface CashierDayInput {
  merchantId: string;
  outletId: string;
  businessDate: string;
}

export type CashierDayTenderMethod = "cash" | "qris_dynamic" | "qris_static";

export interface CashierDayTenderSlice {
  method: CashierDayTenderMethod;
  amountIdr: number;
  count: number;
}

export interface CashierDayRow {
  cashierStaffId: string;
  cashierName: string;
  saleCount: number;
  grossIdr: number;
  voidCount: number;
  voidIdr: number;
  tenderMix: readonly CashierDayTenderSlice[];
  /**
   * `opening_float + cash_sales − cash_refunds` from the matched shift row
   * (KASA-235). `null` when no shift opened for this (outlet, cashier,
   * businessDate); the route layer surfaces null through to the wire so the
   * UI can render "—".
   */
  drawerExpectedIdr: number | null;
}

export interface CashierDayResult {
  rows: readonly CashierDayRow[];
}
