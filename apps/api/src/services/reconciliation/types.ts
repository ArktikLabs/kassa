/*
 * Domain types for static-QRIS reconciliation (ARCHITECTURE.md §3.1 Flow C
 * fallback, ADR-008).
 *
 * The reconciliation pass takes:
 *   - the unverified `qris_static` tenders booked in the local ledger for
 *     a given outlet on a given business date
 *   - the Midtrans settlement-report rows that posted on that same business
 *     date for that merchant
 * and produces a list of matches the caller can then flip to `verified=true`
 * inside a transaction.
 *
 * The matcher is intentionally a pure function: same inputs → same matches,
 * no I/O, no clock. The orchestration layer (`service.ts`) wires it to the
 * Midtrans provider (`fetchSettlementReport`) and the tender repository.
 */

/**
 * Wire shape for an unverified static-QRIS tender as the matcher sees it.
 * `outletId` flows through unchanged so multi-outlet partial matches stay
 * scoped to their outlet — a Jakarta-Selatan settlement row must not match a
 * Surabaya tender even if last4 + amount happen to collide.
 */
export interface UnverifiedStaticQrisTender {
  tenderId: string;
  saleId: string;
  outletId: string;
  amountIdr: number;
  buyerRefLast4: string;
  /** ISO-8601 with explicit offset; KASA-93/97 contract. */
  saleCreatedAt: string;
}

/**
 * Wire shape for a single row in the Midtrans settlement report. `last4`
 * is derived from the buyer's transfer reference — Midtrans returns the
 * full reference, the payments package extracts the last 4 digits before
 * handing the row to the matcher.
 */
export interface SettlementReportRow {
  /** Midtrans `transaction_id`. */
  providerTransactionId: string;
  /** IDR amount the buyer transferred. */
  grossAmountIdr: number;
  /** Last 4 digits of the buyer's transfer reference. */
  last4: string;
  /**
   * ISO-8601 with explicit offset, normalised by the payments package
   * (Midtrans wire shape is `YYYY-MM-DD HH:mm:ss` Asia/Jakarta — see
   * `midtrans.ts#jakartaTimestampToIsoOffset`).
   */
  settledAt: string;
  /** Merchant-side outlet identifier the charge was tagged with. */
  outletId: string;
}

export interface ReconciliationMatch {
  tenderId: string;
  providerTransactionId: string;
  settledAt: string;
}

export interface ReconciliationResult {
  matches: readonly ReconciliationMatch[];
  /** Tenders that did not pair with any settlement row this pass. */
  unmatchedTenderIds: readonly string[];
  /** Settlement rows the matcher could not place against any tender. */
  unmatchedSettlementIds: readonly string[];
}
