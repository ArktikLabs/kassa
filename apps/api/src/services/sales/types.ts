import type { StockLedgerReason } from "../../db/schema/stock.js";

/*
 * Domain types for the sales pipeline. The service works in memory today; a
 * Postgres repository (KASA-21) will drop in behind the same interface using
 * the canonical drizzle tables under `src/db/schema/`.
 *
 * `StockLedgerEntry.reason` matches the canonical `stockLedgerReasonValues`
 * enum verbatim — a sale always writes `"sale"` in v0; voids/refunds land in
 * separate endpoints (KASA-69/70) and reuse the same ledger table.
 */

export interface Item {
  id: string;
  merchantId: string;
  code: string;
  name: string;
  uomId: string;
  bomId: string | null;
  isStockTracked: boolean;
  allowNegative: boolean;
  isActive: boolean;
}

export interface BomComponent {
  componentItemId: string;
  quantity: number;
  uomId: string;
}

export interface Bom {
  id: string;
  itemId: string;
  version: string;
  components: readonly BomComponent[];
}

export interface Outlet {
  id: string;
  merchantId: string;
  code: string;
  name: string;
  timezone: string;
}

export interface StockLedgerEntry {
  id: string;
  outletId: string;
  itemId: string;
  /** Signed; negative for `sale`/`sale_void`/`transfer_out`, positive otherwise. */
  delta: number;
  reason: StockLedgerReason;
  /** Back-link to the row that triggered this movement, e.g. `("sale", sale.id)`. */
  refType: string | null;
  refId: string | null;
  occurredAt: string;
}

export interface SaleLine {
  itemId: string;
  bomId: string | null;
  quantity: number;
  uomId: string;
  unitPriceIdr: number;
  lineTotalIdr: number;
}

export type SaleTenderMethod = "cash" | "qris" | "qris_static" | "card" | "other";

export interface SaleTender {
  method: SaleTenderMethod;
  amountIdr: number;
  reference: string | null;
  /**
   * Server-confirmed against an upstream settlement record. Always `false`
   * for `qris_static` at write time; reconciliation flips it on the
   * server. Absent on every other method on the wire — `undefined` rather
   * than missing so the Zod-inferred parse output assigns cleanly under
   * `exactOptionalPropertyTypes`.
   */
  verified?: boolean | undefined;
  /**
   * Last 4 digits of the buyer's QRIS reference (KASA-118). Required for
   * `qris_static`; absent for every other method.
   */
  buyerRefLast4?: string | null | undefined;
}

/**
 * One booked refund against a sale. A sale can carry many refunds; the
 * server enforces (sum of refund amounts) ≤ sale.totalIdr and per-line
 * (sum of refunded quantity) ≤ original line quantity. `clientRefundId`
 * is the idempotency key — replays return the originally recorded row.
 */
export interface SaleRefund {
  id: string;
  clientRefundId: string;
  refundedAt: string;
  refundBusinessDate: string;
  amountIdr: number;
  reason: string | null;
  lines: readonly { itemId: string; quantity: number }[];
}

export interface Sale {
  id: string;
  merchantId: string;
  outletId: string;
  clerkId: string;
  localSaleId: string;
  name: string;
  businessDate: string;
  subtotalIdr: number;
  discountIdr: number;
  totalIdr: number;
  items: readonly SaleLine[];
  tenders: readonly SaleTender[];
  createdAt: string;
  /** Stamped by `POST /v1/sales/:saleId/void`; null on a live sale. */
  voidedAt: string | null;
  /** Business date the void counts against in EOD variance; null on a live sale. */
  voidBusinessDate: string | null;
  voidReason: string | null;
  /** Booked refunds, ordered by `refundedAt` ascending. */
  refunds: readonly SaleRefund[];
}

export interface SubmitSaleInput {
  merchantId: string;
  outletId: string;
  clerkId: string;
  localSaleId: string;
  businessDate: string;
  createdAt: string;
  subtotalIdr: number;
  discountIdr: number;
  totalIdr: number;
  items: readonly SaleLine[];
  tenders: readonly SaleTender[];
}

export interface SubmitSaleResult {
  sale: Sale;
  ledger: readonly StockLedgerEntry[];
}

export interface VoidSaleInput {
  merchantId: string;
  saleId: string;
  voidedAt: string;
  voidBusinessDate: string;
  reason: string | null;
}

export interface VoidSaleResult {
  sale: Sale;
  ledger: readonly StockLedgerEntry[];
}

export interface RefundSaleInput {
  merchantId: string;
  saleId: string;
  clientRefundId: string;
  refundedAt: string;
  refundBusinessDate: string;
  amountIdr: number;
  reason: string | null;
  lines: readonly { itemId: string; quantity: number }[];
}

export interface RefundSaleResult {
  sale: Sale;
  refund: SaleRefund;
  ledger: readonly StockLedgerEntry[];
}
