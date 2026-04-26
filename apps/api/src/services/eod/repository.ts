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
  insert(record: EodRecord): Promise<EodRecord>;
}
