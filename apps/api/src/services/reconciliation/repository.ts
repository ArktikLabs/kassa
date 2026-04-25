import type { ReconciliationMatch, UnverifiedStaticQrisTender } from "./types.js";

/**
 * Storage seam for the reconciliation pass. The Postgres implementation
 * (lands when KASA-21 is fully wired through the sales pipeline) hits the
 * `tenders` table; the in-memory variant powers the unit suite.
 *
 * The contract is intentionally narrow:
 *   - `listUnverifiedStaticQrisTenders` is read-side only; callers project
 *     the rows into the matcher's input shape.
 *   - `markMatched` is the only write the reconciliation pass performs and
 *     is idempotent: re-running with the same matches must not double-flip
 *     a row's `verified` bit or rewrite a different `paid_at`.
 */
export interface ReconciliationRepository {
  listUnverifiedStaticQrisTenders(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<readonly UnverifiedStaticQrisTender[]>;

  markMatched(matches: readonly ReconciliationMatch[]): Promise<number>;
}
