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
  /**
   * KASA-218 — Indonesian PPN rate as integer percent (0..100). Synced from
   * `itemRecord.taxRate`; defaults to 11 (statutory PPN) when the wire
   * payload omits it (pre-KASA-218 servers). Used by the receipt preview
   * to break out the PPN line locally before the server confirms.
   */
  taxRate: number;
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

/**
 * Tender method codes as written to the local outbox.
 *
 * `qris_static` is the printed-merchant-QR fallback (KASA-64 / ADR-008): the
 * clerk shows the buyer the merchant's static EMV QR, the buyer pays from
 * their banking app, and the clerk captures the last 4 digits of the buyer's
 * reference into `buyerRefLast4`. The tender is stored unverified — server-
 * side reconciliation against the Midtrans EOD settlement report flips
 * `verified` when the row matches by amount + last4 + outlet + ±10-min window.
 */
export type PendingSaleTenderMethod = "cash" | "qris" | "qris_static" | "card" | "other";

export interface PendingSaleTender {
  method: PendingSaleTenderMethod;
  amountIdr: Rupiah;
  reference: string | null;
  /**
   * `true` once the server has matched this tender against an upstream
   * settlement record. Always `false` for `qris_static` at write time;
   * always `true` for `cash` (no settlement needed). Optional on the wire
   * so existing outbox rows survive the schema bump unchanged.
   */
  verified?: boolean;
  /**
   * Last 4 digits of the buyer's QRIS reference, captured by the clerk on
   * the static-QRIS panel. Required for `qris_static` so the back-office
   * matcher can reconcile ambiguous amounts; absent for every other method.
   */
  buyerRefLast4?: string | null;
}

/**
 * Per-outlet cache of the merchant's printed-QR image. The clerk shows this
 * to the buyer when the device is offline (ADR-008 fallback). Cached as a
 * data URL so the panel can render it under StrictMode without re-fetching
 * a Blob URL across renders. Refreshed when older than ~24h.
 */
export interface PrintedQris {
  outletId: string;
  /** Data URL (e.g. `data:image/png;base64,...`) ready to drop into `<img src>`. */
  image: string;
  /** Original MIME type so the receipt printer or admin export can re-encode if needed. */
  mimeType: string;
  fetchedAt: string;
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
  /**
   * KASA-218 — Indonesian PPN component, computed locally from per-item
   * `taxRate` for the receipt preview before submit, and overwritten with
   * the server's authoritative number once the sync settles. Optional so
   * pre-KASA-218 outbox rows survive the schema bump unchanged.
   */
  taxIdr?: Rupiah;
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
  /**
   * KASA-236-B — server's UUID for the sale. Needed by the void route
   * because `POST /v1/sales/:saleId/void` keys on the server id, not the
   * client-stamped `localSaleId`. Optional so pre-KASA-236 outbox rows
   * survive the schema bump unchanged. Captured from the submit response.
   */
  serverSaleId?: string | null;
  /**
   * KASA-236-B — set after a void request enqueues locally OR after the
   * server confirms a void on this sale. Optional so pre-void outbox rows
   * survive the schema bump unchanged. Renders the PEMBATALAN banner.
   */
  voidedAt?: string | null;
  voidBusinessDate?: string | null;
  voidReason?: string | null;
  /** Local void id that flipped this row, mirrors `pending_voids.localVoidId`. */
  voidLocalId?: string | null;
}

/**
 * KASA-236-B — outbox row for `POST /v1/sales/:saleId/void`. Mirrors the
 * pending_sales lifecycle so a void queued offline drains alongside the
 * original sale once connectivity returns. The drain replays the same
 * payload until the server confirms (200/201) or returns a terminal 4xx
 * other than 408/409/429.
 *
 * `managerPin` is held in plaintext for the retry window — the alternative
 * (a hashed PIN) would require re-prompting the cashier on every retry,
 * which defeats the offline-first contract. Dexie is origin-scoped IDB so
 * the surface is the same as any other sensitive POS state (e.g. the
 * device api secret). Rows are deleted from the outbox once `synced`.
 */
export type PendingVoidStatus = "queued" | "sending" | "error" | "needs_attention" | "synced";

export interface PendingVoid {
  /** Primary key. Client-stamped uuidv7 — the `localVoidId` on the wire. */
  localVoidId: string;
  saleId: string;
  /** Local sale id this void targets — used to flip the local PendingSale row. */
  localSaleId: string;
  outletId: string;
  managerStaffId: string;
  managerPin: string;
  voidedAt: string;
  voidBusinessDate: string;
  reason: string | null;
  createdAt: string;
  status: PendingVoidStatus;
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

/**
 * Cashier shift open/close outbox row (KASA-235).
 *
 * Two event kinds ride the same outbox: an "open" event keyed by
 * `openShiftId` and a "close" event keyed by `closeShiftId`. Each event
 * is its own row so retries can replay independently — the close cannot
 * succeed before the open lands, but if the close errors we don't want
 * the next drain to also reattempt the open.
 *
 * Lifecycle mirrors `PendingSale.status`:
 *   queued → sending → (synced | error | needs_attention)
 *
 * The Dexie primary key is `eventId` (the open or close UUID); the
 * `localShiftId` field links open/close events for the same shift so the
 * UI can render a tape without rejoining server data.
 */
export type PendingShiftEventKind = "open" | "close";
export type PendingShiftEventStatus = "queued" | "sending" | "error" | "needs_attention" | "synced";

export interface PendingShiftEvent {
  eventId: string;
  localShiftId: string;
  kind: PendingShiftEventKind;
  outletId: string;
  cashierStaffId: string;
  businessDate: string;
  createdAt: string;
  /** Open event only; null on close-event rows. */
  openShiftId: string | null;
  /** Close event only; null on open-event rows. */
  closeShiftId: string | null;
  /** Open event: cashier-stamped `openedAt`; close event: `closedAt`. */
  occurredAt: string;
  /** Open event only. */
  openingFloatIdr?: number;
  /** Close event only. */
  countedCashIdr?: number;
  status: PendingShiftEventStatus;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
}

/**
 * Local cache of the cashier's open shift. Populated by the open-shift
 * route after a successful enqueue and the server-acknowledged close.
 * Keyed on the singleton id so the boot guard can read it synchronously
 * before deciding whether to redirect to `/shift/open`.
 *
 * `serverShiftId` is null until the open event has been mirrored from
 * the server (200/201 on `POST /v1/shifts/open`); the boot guard treats
 * a row with `localShiftId` set as "an open shift exists" regardless,
 * because the offline outbox guarantees the server will eventually
 * receive it.
 */
export interface ShiftState {
  id: "singleton";
  localShiftId: string;
  outletId: string;
  cashierStaffId: string;
  businessDate: string;
  openShiftId: string;
  openedAt: string;
  openingFloatIdr: number;
  serverShiftId: string | null;
  /** Set when close has been recorded locally; the row is cleared after the close lands. */
  closedAt: string | null;
}
