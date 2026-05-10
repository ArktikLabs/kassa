/*
 * Domain types for the back-office dashboard aggregator (KASA-237).
 *
 * All money is integer rupiah; dates are merchant-local (Asia/Jakarta) calendar
 * dates (YYYY-MM-DD), matching the storage shape on `sales.business_date`.
 */

export interface DashboardSummaryInput {
  merchantId: string;
  /** Optional outlet scope. Null/undefined = "every outlet under this merchant". */
  outletId: string | null;
  /** Inclusive lower bound on `sales.business_date`. */
  from: string;
  /** Inclusive upper bound on `sales.business_date`. */
  to: string;
}

export interface DashboardTenderSlice {
  method: "cash" | "qris_dynamic" | "qris_static";
  amountIdr: number;
  count: number;
}

export interface DashboardItemRow {
  itemId: string;
  name: string;
  revenueIdr: number;
  quantity: number;
}

export interface DashboardSummary {
  grossIdr: number;
  taxIdr: number;
  saleCount: number;
  tenderMix: readonly DashboardTenderSlice[];
  topItemsByRevenue: readonly DashboardItemRow[];
  topItemsByQuantity: readonly DashboardItemRow[];
}
