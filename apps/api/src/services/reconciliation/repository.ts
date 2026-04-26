import type { ReconciliationMatch, UnverifiedStaticQrisTender } from "./types.js";

/**
 * Storage seam for the reconciliation pass. The Postgres implementation
 * (lands when KASA-21 is fully wired through the sales pipeline) hits the
 * `tenders` table; the in-memory variant powers the unit suite.
 *
 * The contract is intentionally narrow:
 *   - `listUnverifiedStaticQrisTenders` is read-side only; callers project
 *     the rows into the matcher's input shape.
 *   - `markMatched` is the only write the automated pass performs and is
 *     idempotent: re-running with the same matches must not double-flip a
 *     row's `verified` bit or rewrite a different `paid_at`.
 *   - `manualMatch` is the owner-driven escape hatch for stuck tenders the
 *     automated pass could not pair. It returns `not_found` when the tender
 *     is unknown to the merchant, `already_verified` when the tender has
 *     already been flipped (idempotent no-op for the caller), or `flipped`
 *     when the tender was just marked verified.
 */
export type ManualMatchOutcome = "flipped" | "already_verified" | "not_found";

export interface ManualMatchInput {
  merchantId: string;
  tenderId: string;
  /**
   * The Midtrans `transaction_id` the operator believes corresponds to this
   * tender, or `null` when no provider row is on hand (e.g. the buyer paid
   * via a transfer that never settled through Midtrans). Stored so an audit
   * can later trace the manual flip back to a settlement row.
   */
  providerTransactionId: string | null;
  /** Free-text justification the clerk entered. Required by the route. */
  note: string;
  /** Acting staff user id, for audit. */
  staffUserId: string;
  /** ISO-8601 with offset, the moment the manual match was applied. */
  matchedAt: string;
}

export interface ReconciliationRepository {
  listUnverifiedStaticQrisTenders(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<readonly UnverifiedStaticQrisTender[]>;

  markMatched(matches: readonly ReconciliationMatch[]): Promise<number>;

  manualMatch(input: ManualMatchInput): Promise<ManualMatchOutcome>;
}
