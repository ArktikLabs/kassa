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
  cardIdr: number;
  otherIdr: number;
  netIdr: number;
}
