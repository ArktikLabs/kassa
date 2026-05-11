import type { StaffRole } from "../../db/schema/staff.js";
import type { Bom, Item, Merchant, Outlet, Sale, SaleRefund, StockLedgerEntry } from "./types.js";

/**
 * KASA-236-A — narrow read port the sales service consults to enforce the
 * "voids are only allowed against the currently-open shift on the sale's
 * outlet, on the same business date" rule. The full `ShiftsRepository`
 * implements this; tests can substitute a tiny stub.
 */
export interface OpenShiftReader {
  findOpenShiftForOutlet(input: {
    merchantId: string;
    outletId: string;
  }): Promise<{ outletId: string; businessDate: string } | null>;
}

/**
 * KASA-236-A — narrow read port the sales service uses to verify the
 * manager's PIN at void time. Returns the manager's role + argon2id
 * `pinHash`; the actual `argon2.verify` runs inside the service so the
 * security boundary is one file. Returns null when the staff id is
 * unknown OR belongs to a different merchant — the service still calls
 * argon2.verify against a timing-decoy hash so the response time is
 * indistinguishable from a wrong-PIN case.
 */
export interface ManagerPinReader {
  findStaffById(input: {
    merchantId: string;
    staffId: string;
  }): Promise<{ id: string; merchantId: string; role: StaffRole; pinHash: string | null } | null>;
}

/*
 * Storage contract. Every method is async so a Postgres implementation (KASA-21)
 * can drop in without a service rewrite.
 *
 * `appendLedger` is atomic with `recordSale`: implementations must persist the
 * ledger rows and the sale in one transaction so a failure in either leaves no
 * partial ledger. The in-memory version performs both writes under a single
 * JS frame, which is sufficient for the single-threaded Fastify event loop.
 */

export interface LedgerAppendInput {
  outletId: string;
  itemId: string;
  delta: number;
  reason: StockLedgerEntry["reason"];
  refType: string | null;
  refId: string | null;
  occurredAt: string;
}

export interface ListLedgerInput {
  merchantId: string;
  outletId: string;
  updatedAfter?: Date;
  pageToken?: string | null;
  limit: number;
}

export interface ListLedgerResult {
  records: StockLedgerEntry[];
  /** Last entry's `occurredAt` when the page is the final window. */
  nextCursor: Date | null;
  /** Opaque within-window page key when more rows remain at this cursor. */
  nextPageToken: string | null;
}

export interface SalesRepository {
  findItemsByIds(merchantId: string, itemIds: readonly string[]): Promise<Item[]>;
  findBomById(bomId: string): Promise<Bom | null>;
  findOutlet(merchantId: string, outletId: string): Promise<Outlet | null>;
  /**
   * Look up the merchant tenant row. The sales service consults
   * `merchant.taxInclusive` on submit to decide how to derive `sale.taxIdr`
   * from per-line totals (KASA-218). Returns null if the merchant id is
   * unknown — never reachable in practice because the route handler resolves
   * the id from an authenticated device session, but kept null-safe so the
   * service can default to inclusive without crashing in edge tests.
   */
  findMerchant(merchantId: string): Promise<Merchant | null>;
  findSaleByLocalId(merchantId: string, localSaleId: string): Promise<Sale | null>;
  /** Running onHand for a single (outlet, item) pair. */
  onHandFor(outletId: string, itemId: string): Promise<number>;
  onHandForMany(outletId: string, itemIds: readonly string[]): Promise<Map<string, number>>;
  /**
   * Return every (itemId, onHand) pair this outlet has any ledger activity
   * for. Used by `GET /v1/stock/snapshot` — the client pulls the whole list
   * on each sync cycle (ARCHITECTURE.md §3.1).
   */
  allOnHandForOutlet(outletId: string): Promise<Map<string, number>>;
  recordSale(input: {
    sale: Sale;
    ledger: readonly Omit<StockLedgerEntry, "id">[];
    idGenerator: () => string;
  }): Promise<{ sale: Sale; ledger: StockLedgerEntry[] }>;
  /**
   * Every sale bucketed to (merchant, outlet, businessDate). Stable ordering
   * by `createdAt` so EOD breakdown rollups are deterministic. Consumed by
   * the EOD service via the `SalesReader` port; no other caller today.
   */
  listSalesByBusinessDate(
    merchantId: string,
    outletId: string,
    businessDate: string,
  ): Promise<readonly Sale[]>;
  /**
   * Lookup by server saleId. Returns null if the sale does not exist or
   * belongs to a different merchant — the route handler maps that to 404
   * without leaking cross-tenant existence.
   */
  findSaleById(merchantId: string, saleId: string): Promise<Sale | null>;
  /**
   * Delta-pull the append-only stock ledger for one (merchant, outlet)
   * bucket. Ordering is `(occurredAt ASC, id ASC)`; pagination uses the
   * shared opaque page-token shape (`{a: occurredAt, i: id}`). Used by the
   * acceptance suite to assert post-drain BOM deductions; an outlet that
   * does not belong to the merchant returns an empty bucket so cross-tenant
   * existence does not leak.
   */
  listLedger(input: ListLedgerInput): Promise<ListLedgerResult>;
  /**
   * KASA-236-A — resolve a sale by (merchantId, localVoidId). The service
   * uses this to enforce void-event idempotency: a `localVoidId` already
   * bound to a different `saleId` is a 409 `void_idempotency_conflict`
   * rather than a silent overwrite. Returns null when the localVoidId is
   * unknown or belongs to another merchant.
   */
  findSaleByLocalVoidId(input: { merchantId: string; localVoidId: string }): Promise<Sale | null>;
  /**
   * Atomically stamp the void on the sale row and append the balancing
   * ledger entries. If the sale is already voided the implementation must
   * return `{ kind: "already_voided", sale }` so the route can answer 200
   * idempotently — never re-write the ledger. `localVoidId` /
   * `voidedByStaffId` are persisted on the sale row at first-void time.
   */
  voidSale(input: {
    merchantId: string;
    saleId: string;
    localVoidId: string;
    voidedByStaffId: string;
    voidedAt: string;
    voidBusinessDate: string;
    reason: string | null;
    ledger: readonly Omit<StockLedgerEntry, "id">[];
    idGenerator: () => string;
  }): Promise<
    { kind: "ok"; sale: Sale; ledger: StockLedgerEntry[] } | { kind: "already_voided"; sale: Sale }
  >;
  /**
   * Atomically append the refund row + balancing ledger writes. If
   * `clientRefundId` is already present on the sale the implementation must
   * return `{ kind: "already_refunded", sale, refund }` so the route can
   * answer 200 idempotently.
   */
  recordRefund(input: {
    merchantId: string;
    saleId: string;
    clientRefundId: string;
    refundedAt: string;
    refundBusinessDate: string;
    amountIdr: number;
    reason: string | null;
    lines: readonly { itemId: string; quantity: number }[];
    ledger: readonly Omit<StockLedgerEntry, "id">[];
    idGenerator: () => string;
  }): Promise<
    | { kind: "ok"; sale: Sale; refund: SaleRefund; ledger: StockLedgerEntry[] }
    | { kind: "already_refunded"; sale: Sale; refund: SaleRefund }
  >;
  /**
   * KASA-151 — write balancing `synthetic_eod_reconcile` ledger entries for
   * the given synthetic sale ids. Each balancing entry mirrors an existing
   * `reason="sale"` row for that saleId with an inverted `delta`, so per-
   * item stock nets to zero. Skips sales that already have balancing
   * entries to keep the operation idempotent across replay/retry. Returns
   * the entries this call wrote (an empty array when every sale was
   * already reconciled). The caller stamps `occurredAt` so EOD-time and
   * reconciliation-time match the close timestamp.
   */
  reconcileSyntheticSales(input: {
    saleIds: readonly string[];
    occurredAt: string;
    idGenerator: () => string;
  }): Promise<StockLedgerEntry[]>;
}
