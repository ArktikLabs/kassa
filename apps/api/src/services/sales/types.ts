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

export interface SaleTender {
  method: "cash" | "qris" | "card" | "other";
  amountIdr: number;
  reference: string | null;
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
