import type { EodRecord, SaleRecord } from "./types.js";

/*
 * The EOD service reads sales through a narrow port (`SalesReader`) and
 * writes EOD rows through a second narrow port (`EodRepository`). Sales
 * themselves are owned by `services/sales` (KASA-66); the only place the
 * KASA-66 `Sale` shape gets translated to the EOD-domain `SaleRecord` is
 * the `SalesReader` adapter. See `sales-reader.ts`.
 *
 * The EnrolmentRepository in `services/enrolment/repository.ts` is the
 * design precedent for `EodRepository`: one narrow interface, an in-memory
 * impl for dev/test, and a Drizzle impl to land in KASA-21.
 */

export interface SalesReader {
  /**
   * Every sale (including voided ones) bucketed to the given (merchant,
   * outlet, businessDate). The EOD service uses this list both to reconcile
   * against `clientSaleIds` and to compute the canonical breakdown; voided
   * sales contribute to `voidCount` only.
   */
  listSalesByBusinessDate(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<readonly SaleRecord[]>;
}

export interface EodRepository {
  findExisting(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<EodRecord | null>;
  /**
   * Look an EOD record up by its server-generated id, scoped to the
   * authenticated merchant so cross-tenant reads are never possible
   * even with a guessed id.
   */
  findById(input: { merchantId: string; eodId: string }): Promise<EodRecord | null>;
  insert(record: EodRecord): Promise<EodRecord>;
}

/**
 * KASA-151 — write balancing `synthetic_eod_reconcile` ledger entries
 * during EOD close so per-item stock for synthetic-tender (KASA-71 probe)
 * sales nets to zero. Implementations must be idempotent on
 * `(saleIds, occurredAt)` so a retried close never double-writes the
 * balancing entries. The EOD service calls this once per close, before
 * inserting the EOD record; in v0 the writes are sequential and the
 * Postgres impl will run both inside the close transaction.
 */
export interface EodSyntheticReconciler {
  reconcileSyntheticSales(input: { saleIds: readonly string[]; occurredAt: string }): Promise<void>;
}
