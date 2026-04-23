import type { Rupiah } from "../../shared/money/index.ts";

export type ReferenceTable = "items" | "boms" | "uoms" | "outlets" | "stock_snapshot";
export type SyncTable = ReferenceTable | "pending_sales";

export interface Uom {
  id: string;
  code: string;
  name: string;
  updatedAt: string;
}

export interface Item {
  id: string;
  code: string;
  name: string;
  priceIdr: Rupiah;
  uomId: string;
  bomId: string | null;
  isStockTracked: boolean;
  isActive: boolean;
  updatedAt: string;
}

export interface BomComponent {
  componentItemId: string;
  quantity: number;
  uomId: string;
}

export interface Bom {
  id: string;
  itemId: string;
  components: readonly BomComponent[];
  updatedAt: string;
}

export interface Outlet {
  id: string;
  code: string;
  name: string;
  timezone: string;
  updatedAt: string;
}

export interface StockSnapshot {
  key: string;
  outletId: string;
  itemId: string;
  onHand: number;
  updatedAt: string;
}

export interface PendingSaleTender {
  method: "cash" | "qris" | "card" | "other";
  amountIdr: Rupiah;
  reference: string | null;
}

export interface PendingSaleItem {
  itemId: string;
  bomId: string | null;
  quantity: number;
  uomId: string;
  unitPriceIdr: Rupiah;
  lineTotalIdr: Rupiah;
}

export interface PendingSale {
  localSaleId: string;
  outletId: string;
  clerkId: string;
  businessDate: string;
  createdAt: string;
  subtotalIdr: Rupiah;
  discountIdr: Rupiah;
  totalIdr: Rupiah;
  items: readonly PendingSaleItem[];
  tenders: readonly PendingSaleTender[];
  status: "queued" | "sending" | "error";
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
}

export interface SyncState {
  table: SyncTable;
  cursor: string | null;
  lastPulledAt: string | null;
  lastPushedAt: string | null;
}

export interface DeviceSecret {
  id: "singleton";
  deviceId: string;
  outletId: string;
  merchantId: string;
  apiKeyHash: string;
  apiSecret: string;
  rotatedAt: string;
}

export function stockSnapshotKey(outletId: string, itemId: string): string {
  return `${outletId}::${itemId}`;
}
