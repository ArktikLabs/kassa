/*
 * KASA-369 — receipt-code helpers.
 *
 * The receipt code shown to a buyer is the last six characters of the
 * sale's `localSaleId` (the trailing hex of the UUIDv7), uppercased. Six
 * chars of random hex from the UUIDv7 random tail yield a 1/16,777,216
 * collision rate per outlet, which is comfortably below the count a
 * single warung produces across the configurable retention window
 * (Dexie keeps roughly the last 50 sales per outlet; see
 * `pendingSalesRepo.listRecentByOutlet`).
 *
 * Input forgiveness: the cashier types the code from a printed receipt,
 * which means we accept hyphens, spaces, and mixed case — all stripped
 * to A-Z0-9 before comparison.
 */

import type { PendingSale } from "../../data/db/types.ts";

export const RECEIPT_CODE_LENGTH = 6;

/**
 * Derive the displayable receipt code for a sale: last six chars of
 * `localSaleId`, uppercased. UUIDv7 has 12 hex chars in its trailing
 * group, so `slice(-6)` always returns six hex characters (never a
 * stray hyphen).
 */
export function receiptCodeFor(localSaleId: string): string {
  return localSaleId.slice(-RECEIPT_CODE_LENGTH).toUpperCase();
}

/**
 * Normalise cashier input to the canonical comparable form, or return
 * null when the input cannot match any receipt code (wrong length,
 * non-alphanumeric content after stripping). Strips hyphens, spaces,
 * and the leading `#` clerks sometimes prefix the code with.
 */
export function normalizeReceiptCode(input: string): string | null {
  const cleaned = input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (cleaned.length !== RECEIPT_CODE_LENGTH) return null;
  return cleaned;
}

/**
 * Pure matcher used by both the screen and tests: returns the first sale
 * whose derived receipt code equals the normalised query, or null. We do
 * not assume sales are pre-filtered by outlet — callers pass the outlet's
 * recent-sales slice, then this scans linearly.
 */
export function findSaleByReceiptCode(
  sales: readonly PendingSale[],
  code: string,
): PendingSale | null {
  for (const sale of sales) {
    if (receiptCodeFor(sale.localSaleId) === code) return sale;
  }
  return null;
}
