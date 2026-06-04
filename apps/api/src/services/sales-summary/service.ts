import { SALES_SUMMARY_MAX_RANGE_DAYS } from "@kassa/schemas/salesSummary";
import type { SalesSummaryRepository } from "./repository.js";
import type { SalesSummary, SalesSummaryInput } from "./types.js";

/*
 * Thin orchestrator over the sales-summary repository (KASA-327).
 *
 * Enforces the two invariants the route doesn't:
 *   1. `from <= to` (a flipped window is a client bug, not a 0-row report).
 *   2. The window is at most `SALES_SUMMARY_MAX_RANGE_DAYS` (inclusive) wide.
 *      Longer ranges are rejected with `range_too_large` so the route can
 *      surface a non-scary 400 instead of timing out a full-year aggregate.
 *
 * Every other concern — merchant scoping, role gating, response shaping —
 * lives in the route handler so the schema-driven OpenAPI export stays the
 * source of truth. Aggregation lives in the repository.
 */

export type SalesSummaryErrorCode = "invalid_date_range" | "range_too_large";

export class SalesSummaryError extends Error {
  constructor(
    readonly code: SalesSummaryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SalesSummaryError";
  }
}

export interface SalesSummaryServiceDeps {
  repository: SalesSummaryRepository;
}

export class SalesSummaryService {
  private readonly repository: SalesSummaryRepository;

  constructor(deps: SalesSummaryServiceDeps) {
    this.repository = deps.repository;
  }

  async getSummary(input: SalesSummaryInput): Promise<SalesSummary> {
    if (input.from > input.to) {
      throw new SalesSummaryError(
        "invalid_date_range",
        `from (${input.from}) must be <= to (${input.to})`,
      );
    }
    const span = inclusiveDaySpan(input.from, input.to);
    if (span > SALES_SUMMARY_MAX_RANGE_DAYS) {
      throw new SalesSummaryError(
        "range_too_large",
        `Date range ${input.from}..${input.to} spans ${span} days; the cap is ${SALES_SUMMARY_MAX_RANGE_DAYS}. Pick a shorter window.`,
      );
    }
    return this.repository.getSalesSummary(input);
  }
}

/** Inclusive day count between two `YYYY-MM-DD` strings; assumes `from <= to`. */
function inclusiveDaySpan(from: string, to: string): number {
  // Treat both bounds as midnight UTC so the diff is unaffected by DST in
  // any host timezone. The route only ever feeds Asia/Jakarta business
  // dates so this is purely an arithmetic device.
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}
