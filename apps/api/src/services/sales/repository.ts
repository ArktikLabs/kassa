import type { Bom, Item, Outlet, Sale, StockLedgerEntry } from "./types.js";

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
}
