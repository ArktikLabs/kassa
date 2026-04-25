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

/**
 * Outbox lifecycle:
 *  - `queued` — ready to push on the next drain cycle.
 *  - `sending` — a drain picked the row up and is awaiting the response.
 *    On app boot any stuck `sending` rows are reset to `queued` because
 *    the tab may have died mid-flight.
 *  - `error` — the last POST returned a retriable failure (network, 5xx,
 *    408, 429). The drain will re-enter these rows next cycle and the SW
 *    `BackgroundSyncPlugin` replays in-flight requests across activations.
 *  - `needs_attention` — the server returned a terminal validation
 *    failure (4xx other than 408/409/429). Surfaced in the admin
 *    "Perlu perhatian" list; clerk requeues with "Coba kirim ulang".
 *  - `synced` — the server has canonical knowledge of the sale (200 on
 *    first attempt or 409 on a duplicate). Kept for receipt reprints;
 *    `serverSaleName` is the server's canonical identifier used for
 *    back-office links.
 */
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
  status: "queued" | "sending" | "error" | "needs_attention" | "synced";
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  /**
   * Server's canonical sale identifier, populated by the first 2xx or by
   * the 409 reconciliation fetch. `null` until the sale is durably on the
   * server; the receipt reprint screen can still render from the local row.
   */
  serverSaleName: string | null;
}

export interface SyncState {
  table: SyncTable;
  cursor: string | null;
  lastPulledAt: string | null;
  lastPushedAt: string | null;
}

/**
 * Read-only marker that the outlet's business day has been closed on the
 * server. Keyed on `outletId::businessDate` (see `eodClosureKey`). The PWA
 * writes it after a successful `POST /v1/eod/close` so re-visiting `/eod`
 * for that date renders the summary without re-posting, and the catalog
 * could later refuse new sales for a locked date (future work).
 */
export interface EodClosure {
  key: string;
  outletId: string;
  businessDate: string;
  eodId: string;
  closedAt: string;
  countedCashIdr: number;
  expectedCashIdr: number;
  varianceIdr: number;
  varianceReason: string | null;
}

/**
 * Device credentials returned by `POST /v1/auth/enroll` and kept in IndexedDB
 * (never `localStorage` — ARCHITECTURE.md §2.1). The field `apiKey` holds the
 * raw key the client sends on every request; the server stores only its hash
 * (see `apps/api/src/db/schema/devices.ts`). `outletName` / `merchantName` are
 * persisted alongside for the "Perangkat terhubung ke [outlet]" toast and
 * admin reset screen without a round-trip when offline.
 */
export interface DeviceSecret {
  id: "singleton";
  deviceId: string;
  outletId: string;
  outletName: string;
  merchantId: string;
  merchantName: string;
  apiKey: string;
  apiSecret: string;
  enrolledAt: string;
}

/**
 * Device-scoped metadata that must outlive the device secret. The fingerprint
 * is generated once on first enrolment attempt (`crypto.randomUUID()`), sent
 * to the server, and preserved across `resetDevice()` so a re-enrolled tablet
 * still correlates to its previous enrolment audit-log entry.
 */
export interface DeviceMeta {
  id: "singleton";
  fingerprint: string;
}

export function stockSnapshotKey(outletId: string, itemId: string): string {
  return `${outletId}::${itemId}`;
}

export function eodClosureKey(outletId: string, businessDate: string): string {
  return `${outletId}::${businessDate}`;
}
