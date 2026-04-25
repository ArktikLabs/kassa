import type { EodRecord, SaleRecord } from "./types.js";

/*
 * The data plane behind the EOD close + the minimal sales submit shim.
 * Both surfaces live behind one repository so the in-memory and (future)
 * Drizzle backends can co-locate the rows they need to reconcile. The
 * EnrolmentRepository in `services/enrolment/repository.ts` is the design
 * precedent: one narrow interface, one in-memory impl for dev/test, a
 * Drizzle impl to land in KASA-21 / KASA-23.
 */

export interface UpsertSaleInput {
  record: SaleRecord;
}

export type UpsertSaleOutcome =
  | { status: "created"; record: SaleRecord }
  | {
      /**
       * The repository already had a sale with this `(merchantId, localSaleId)`.
       * Idempotency win — the caller translates this to 409 so the client
       * can short-circuit its outbox drain.
       */
      status: "duplicate";
      existing: SaleRecord;
    };

export interface SalesReader {
  /**
   * Every non-voided sale bucketed to the given (merchant, outlet,
   * businessDate). The EOD service uses this list to reconcile against
   * `clientSaleIds` and to compute the canonical breakdown.
   */
  listForClose(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<readonly SaleRecord[]>;
}

export interface SalesWriter {
  upsertSale(input: UpsertSaleInput): Promise<UpsertSaleOutcome>;
}

export interface EodRepository {
  findExisting(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<EodRecord | null>;
  insert(record: EodRecord): Promise<EodRecord>;
}

/** The shape every EOD pipeline wires together. */
export interface EodDataPlane extends SalesReader, SalesWriter, EodRepository {}
