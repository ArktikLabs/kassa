/*
 * Canonical server-side shapes for sales + end-of-day. The in-memory repo
 * stores these directly; a future Drizzle implementation (KASA-21) will
 * map these to Postgres rows without changing the service contract.
 */

export type SaleTenderMethod = "cash" | "qris_dynamic" | "qris_static" | "card" | "other";

export interface SaleTender {
  method: SaleTenderMethod;
  amountIdr: number;
  reference: string | null;
  /**
   * `true` once the money is server-vouched: cash count-in, dynamic-QRIS
   * webhook (KASA-63), or the static-QRIS reconciliation pass (KASA-64).
   * For non-QRIS tenders this is always `true` — only static QRIS has an
   * unverified window.
   */
  verified: boolean;
}

export interface SaleItem {
  itemId: string;
  quantity: number;
  unitPriceIdr: number;
  lineTotalIdr: number;
}

export interface SaleRecord {
  localSaleId: string;
  merchantId: string;
  outletId: string;
  businessDate: string; // YYYY-MM-DD, outlet-local
  clerkId: string;
  createdAt: string; // ISO-8601 with offset
  subtotalIdr: number;
  discountIdr: number;
  totalIdr: number;
  items: readonly SaleItem[];
  tenders: readonly SaleTender[];
  voidedAt: string | null;
}

export interface EodRecord {
  id: string;
  outletId: string;
  merchantId: string;
  businessDate: string;
  closedAt: string;
  countedCashIdr: number;
  expectedCashIdr: number;
  varianceIdr: number;
  varianceReason: string | null;
  breakdown: EodRecordBreakdown;
  clientSaleIds: readonly string[];
}

export interface EodRecordBreakdown {
  saleCount: number;
  voidCount: number;
  cashIdr: number;
  qrisDynamicIdr: number;
  qrisStaticIdr: number;
  /**
   * Subset of `qrisStaticIdr` whose tenders haven't been paired with a
   * Midtrans settlement row yet. The clerk sees this on the close screen
   * as the variance-risk number — real money the server cannot vouch for
   * until the next reconciliation pass runs.
   */
  qrisStaticUnverifiedIdr: number;
  cardIdr: number;
  otherIdr: number;
  netIdr: number;
}
