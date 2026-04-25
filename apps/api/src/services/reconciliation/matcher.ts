import type {
  ReconciliationMatch,
  ReconciliationResult,
  SettlementReportRow,
  UnverifiedStaticQrisTender,
} from "./types.js";

/*
 * Pure matcher for static-QRIS reconciliation (KASA-64).
 *
 * Pairs each unverified tender with at most one settlement row when all
 * four match: `last4`, `amountIdr`, `outletId`, and `|saleCreatedAt −
 * settledAt| ≤ windowMs`. The window is configurable but defaults to
 * 10 minutes per the issue AC; that's wide enough to absorb clock skew
 * between the buyer's bank, Midtrans, and the POS tablet, and tight
 * enough that a clerk repeating an amount + last-4 next morning won't
 * collide with a settlement row from the previous afternoon.
 *
 * Deterministic tie-break: when multiple settlement rows are eligible
 * for the same tender, prefer the row whose `settledAt` is closest to
 * the sale; on a tie of nearness, prefer the lexicographically smaller
 * `providerTransactionId`. Either choice is correct money-wise (both
 * rows have the same amount + last4 + outlet); we want the matcher to
 * be stable across reruns so an operator viewing a "matched" tender
 * sees the same provider row each time.
 */

export const DEFAULT_RECONCILIATION_WINDOW_MS = 10 * 60 * 1000;

export interface MatcherOptions {
  /** Half-width of the time window, in ms. Default 10 min. */
  windowMs?: number;
}

export function reconcileStaticQrisTenders(
  tenders: readonly UnverifiedStaticQrisTender[],
  rows: readonly SettlementReportRow[],
  options: MatcherOptions = {},
): ReconciliationResult {
  const windowMs = options.windowMs ?? DEFAULT_RECONCILIATION_WINDOW_MS;

  const tendersWithEpoch = tenders.map((tender) => ({
    tender,
    saleEpoch: parseEpoch(tender.saleCreatedAt, "saleCreatedAt", tender.tenderId),
  }));

  const candidates = rows.map((row) => ({
    row,
    settledEpoch: parseEpoch(row.settledAt, "settledAt", row.providerTransactionId),
    consumed: false,
  }));

  const matches: ReconciliationMatch[] = [];
  const unmatchedTenderIds: string[] = [];

  // Stable tender ordering by saleCreatedAt then tenderId so the tie-break
  // below is reproducible across runs even when callers pass in different
  // orderings (e.g. paginated DB read vs in-memory).
  const orderedTenders = [...tendersWithEpoch].sort((a, b) => {
    if (a.saleEpoch !== b.saleEpoch) return a.saleEpoch - b.saleEpoch;
    return a.tender.tenderId.localeCompare(b.tender.tenderId);
  });

  for (const { tender, saleEpoch } of orderedTenders) {
    let winner: (typeof candidates)[number] | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    let bestTxnId = "";
    for (const candidate of candidates) {
      if (candidate.consumed) continue;
      const row = candidate.row;
      if (row.outletId !== tender.outletId) continue;
      if (row.grossAmountIdr !== tender.amountIdr) continue;
      if (row.last4 !== tender.buyerRefLast4) continue;
      const delta = Math.abs(candidate.settledEpoch - saleEpoch);
      if (delta > windowMs) continue;
      if (
        delta < bestDelta ||
        (delta === bestDelta && row.providerTransactionId.localeCompare(bestTxnId) < 0)
      ) {
        winner = candidate;
        bestDelta = delta;
        bestTxnId = row.providerTransactionId;
      }
    }

    if (winner === null) {
      unmatchedTenderIds.push(tender.tenderId);
      continue;
    }

    winner.consumed = true;
    matches.push({
      tenderId: tender.tenderId,
      providerTransactionId: winner.row.providerTransactionId,
      settledAt: winner.row.settledAt,
    });
  }

  const unmatchedSettlementIds = candidates
    .filter((c) => !c.consumed)
    .map((c) => c.row.providerTransactionId);

  return { matches, unmatchedTenderIds, unmatchedSettlementIds };
}

function parseEpoch(iso: string, field: string, ownerId: string): number {
  const epoch = Date.parse(iso);
  if (!Number.isFinite(epoch)) {
    throw new Error(
      `reconciliation matcher: ${field}=${JSON.stringify(iso)} on ${ownerId} is not a parseable ISO-8601 timestamp.`,
    );
  }
  return epoch;
}
