/*
 * Domain types for the period-summary aggregator (KASA-327).
 *
 * Money is integer rupiah; dates are merchant-local (Asia/Jakarta) calendar
 * dates (YYYY-MM-DD), matching the storage shape on `sales.business_date`.
 * The shape mirrors the wire response in `@kassa/schemas/salesSummary` so
 * the route handler is a trivial shallow copy.
 */

export type SalesSummaryGroupBy = "day" | "outlet" | "tender" | "item";

export interface SalesSummaryInput {
  merchantId: string;
  /** Optional outlet scope. Null = "every outlet under this merchant". */
  outletId: string | null;
  /** Inclusive lower bound on `sales.business_date`. */
  from: string;
  /** Inclusive upper bound on `sales.business_date`. */
  to: string;
  groupBy: SalesSummaryGroupBy;
}

export interface SalesSummaryTenderSlice {
  method: "cash" | "qris_dynamic" | "qris_static";
  amountIdr: number;
  count: number;
}

export interface SalesSummaryItemRow {
  itemId: string;
  name: string;
  revenueIdr: number;
  quantity: number;
}

export interface SalesSummaryGroupRow {
  key: string;
  label: string;
  grossIdr: number;
  discountIdr: number;
  taxIdr: number;
  netIdr: number;
  saleCount: number;
  refundCount: number;
  refundIdr: number;
  quantity: number;
}

export interface SalesSummary {
  grossIdr: number;
  discountIdr: number;
  taxIdr: number;
  saleCount: number;
  refundCount: number;
  refundIdr: number;
  tenderMix: readonly SalesSummaryTenderSlice[];
  topItemsByRevenue: readonly SalesSummaryItemRow[];
  topItemsByQuantity: readonly SalesSummaryItemRow[];
  groups: readonly SalesSummaryGroupRow[];
}
