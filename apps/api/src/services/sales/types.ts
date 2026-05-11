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
  /**
   * Catalog list price in integer rupiah. The sales service treats this as
   * authoritative on submit: client `unitPriceIdr` is validated for internal
   * arithmetic consistency, then replaced with this value before persistence
   * (KASA-113). Components and untracked ingredients carry this for type
   * uniformity even though the field is only consumed for items appearing as
   * sale lines.
   */
  priceIdr: number;
  uomId: string;
  bomId: string | null;
  isStockTracked: boolean;
  allowNegative: boolean;
  /**
   * KASA-218 — Indonesian PPN (VAT) rate as integer percent (0..100). The
   * sales service multiplies `lineTotalIdr` by this and rounds per-line to
   * derive `sale.taxIdr`. Components carry the field for type uniformity
   * but tax is only ever sourced from items that appear as sale lines.
   */
  taxRate: number;
  isActive: boolean;
}

export interface Merchant {
  id: string;
  /**
   * KASA-218 — pricing convention for Indonesian PPN. When true (the
   * Indonesian default), `item.priceIdr` is treated as tax-inclusive on
   * submit and `taxIdr` is reverse-derived from the line totals. When
   * false, tax is added on top of the catalog price and `totalIdr`
   * includes it.
   */
  taxInclusive: boolean;
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

export type SaleTenderMethod =
  | "cash"
  | "qris"
  | "qris_static"
  | "card"
  | "other"
  /**
   * KASA-151 — reserved for the KASA-71 production uptime probe. Sales paid
   * with `synthetic` are flagged on the row and auto-reconciled at EOD; the
   * POS UI must never emit this method.
   */
  | "synthetic";

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
  /**
   * KASA-218 — server-derived Indonesian PPN component, summed from each
   * line's `round(lineTotal × rate / (rate + 100))` (inclusive merchant) or
   * `round(lineTotal × rate / 100)` (exclusive merchant). For inclusive
   * merchants, the amount is embedded inside `subtotalIdr` / `totalIdr`;
   * for exclusive merchants, `totalIdr = subtotalIdr − discountIdr + taxIdr`.
   */
  taxIdr: number;
  items: readonly SaleLine[];
  tenders: readonly SaleTender[];
  createdAt: string;
  /** Stamped by `POST /v1/sales/:saleId/void`; null on a live sale. */
  voidedAt: string | null;
  /** Business date the void counts against in EOD variance; null on a live sale. */
  voidBusinessDate: string | null;
  voidReason: string | null;
  /**
   * KASA-236-A — client-supplied UUIDv7 idempotency key for the void event.
   * Non-null on a voided sale; null on a live sale. Stored so a retried
   * void push from the offline outbox collapses onto the same row.
   */
  localVoidId: string | null;
  /** Staff (owner/manager) whose PIN authorised the void; null on a live sale. */
  voidedByStaffId: string | null;
  /** Booked refunds, ordered by `refundedAt` ascending. */
  refunds: readonly SaleRefund[];
  /**
   * KASA-151 — `true` when the sale was paid with the `synthetic` tender
   * (KASA-71 production uptime probe). EOD close excludes synthetic rows
   * from breakdown / expected-cash / variance and writes balancing
   * `synthetic_eod_reconcile` ledger entries so per-item stock nets to
   * zero. Default `false` for every merchant-facing sale.
   */
  synthetic: boolean;
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
  /** KASA-236-A — void-event idempotency key (UUIDv7). */
  localVoidId: string;
  /** Manager (owner/manager role) authorising the void. */
  managerStaffId: string;
  /** Manager's lock-screen PIN (4–8 digits). Hashed verified server-side. */
  managerPin: string;
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
