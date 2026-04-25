import type { Bom, Item, Outlet, Sale, SaleRefund, StockLedgerEntry } from "./types.js";

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

export interface SalesRepository {
  findItemsByIds(merchantId: string, itemIds: readonly string[]): Promise<Item[]>;
  findBomById(bomId: string): Promise<Bom | null>;
  findOutlet(merchantId: string, outletId: string): Promise<Outlet | null>;
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
   * Atomically stamp the void on the sale row and append the balancing
   * ledger entries. If the sale is already voided the implementation must
   * return `{ kind: "already_voided", sale }` so the route can answer 200
   * idempotently — never re-write the ledger.
   */
  voidSale(input: {
    merchantId: string;
    saleId: string;
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
}
