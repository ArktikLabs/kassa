import type { PaymentProvider } from "@kassa/payments";
import { reconcileStaticQrisTenders } from "./matcher.js";
import type { ReconciliationRepository } from "./repository.js";
import type { ReconciliationResult } from "./types.js";

/*
 * Static-QRIS reconciliation service (KASA-64).
 *
 * Orchestrates the nightly reconciliation pass for a single
 * (merchant, outlet, businessDate) tuple:
 *
 *   1. read every unverified `qris_static` tender booked for that bucket
 *   2. fetch the Midtrans settlement report rows that posted on that date
 *   3. run the pure matcher to pair them
 *   4. flip the matched tenders to `verified=true` in storage
 *
 * Idempotent by construction: step 1 only returns rows the matcher has not
 * yet paired, and `markMatched` is a no-op for rows already verified. A
 * rerun of the same date is therefore safe and converges on a fixed point.
 *
 * Errors propagate verbatim. The caller (HTTP endpoint, BullMQ worker once
 * KASA-111 lands the broker) is responsible for retry/backoff and for
 * distinguishing recoverable transport failures (`midtrans_timeout`) from
 * configuration faults (`invalid_business_date`).
 */

export interface ReconciliationServiceDeps {
  repository: ReconciliationRepository;
  provider: PaymentProvider;
  /** Override the default ±10-min match window, in ms. */
  windowMs?: number;
}

export interface ReconcilePassInput {
  merchantId: string;
  outletId: string;
  businessDate: string;
}

export interface ReconcilePassReport extends ReconciliationResult {
  /** Number of tender rows actually flipped from unverified → verified. */
  matchedCount: number;
  /** Number of unverified tenders the repository surfaced going in. */
  consideredTenderCount: number;
  /** Number of settlement rows the provider returned for the date. */
  settlementRowCount: number;
}

export class ReconciliationService {
  private readonly repository: ReconciliationRepository;
  private readonly provider: PaymentProvider;
  private readonly windowMs: number | undefined;

  constructor(deps: ReconciliationServiceDeps) {
    this.repository = deps.repository;
    this.provider = deps.provider;
    this.windowMs = deps.windowMs;
  }

  async reconcileBusinessDate(input: ReconcilePassInput): Promise<ReconcilePassReport> {
    const tenders = await this.repository.listUnverifiedStaticQrisTenders(input);
    const settlements = await this.provider.fetchQrisSettlements({
      businessDate: input.businessDate,
      merchantId: input.merchantId,
    });
    const matchOptions = this.windowMs !== undefined ? { windowMs: this.windowMs } : undefined;
    const matchResult = reconcileStaticQrisTenders(tenders, settlements, matchOptions);
    const matchedCount = await this.repository.markMatched(matchResult.matches);
    return {
      ...matchResult,
      matchedCount,
      consideredTenderCount: tenders.length,
      settlementRowCount: settlements.length,
    };
  }
}
