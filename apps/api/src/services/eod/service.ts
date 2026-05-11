import type { EodMissingSalesDetails } from "@kassa/schemas/eod";
import { uuidv7 } from "../../lib/uuid.js";
import type { ShiftReader } from "../shifts/repository.js";
import type { EodRepository, EodSyntheticReconciler, SalesReader } from "./repository.js";
import type { EodRecord, EodRecordBreakdown, SaleRecord, SaleTender } from "./types.js";

/*
 * EOD close pipeline (ARCHITECTURE.md §3.1 Flow D).
 *
 * The service is the single place that enforces:
 *   - `(outlet, businessDate)` is idempotent-lockable: the second close
 *     against the same tuple fails with `eod_already_closed`
 *   - every `clientSaleId` the PWA sent is present in the sales ledger;
 *     any mismatch surfaces as `eod_sale_mismatch` with the missing list
 *   - variance = counted − expected; non-zero variance requires a reason
 *
 * Sales are owned by `services/sales` (KASA-66). EOD reads them through
 * the `SalesReader` port, which wraps `SalesRepository.listSalesByBusinessDate`.
 * The EOD-domain `SaleRecord` widens the wire `qris` enum into
 * `qris_dynamic` / `qris_static`; when KASA-74 (payments reconciliation)
 * starts marking sales as webhook-verified, the EOD numbers follow with
 * no code change here.
 */

export class EodError extends Error {
  constructor(
    readonly code:
      | "eod_already_closed"
      | "eod_sale_mismatch"
      | "eod_variance_reason_required"
      | "eod_not_found",
    message: string,
    readonly details?: EodMissingSalesDetails,
  ) {
    super(message);
    this.name = "EodError";
  }
}

export interface EodServiceDeps {
  salesReader: SalesReader;
  eodRepository: EodRepository;
  /**
   * KASA-151 — writes balancing ledger entries for synthetic (KASA-71
   * probe) sales during close. Optional: when omitted, synthetic sales
   * are still excluded from the breakdown but no balancing entries are
   * written — the missing entries leave per-item stock skewed, so this
   * dependency must be provided in any environment that allows synthetic
   * tenders.
   */
  syntheticReconciler?: EodSyntheticReconciler;
  /**
   * KASA-235 — resolves the shift opened on the (outlet, businessDate)
   * tuple so the close pulls `openingFloatIdr` into the expected-cash
   * calculation. Optional: when omitted EOD treats the float as zero,
   * which preserves the pre-KASA-235 behaviour for environments that do
   * not run the shifts pipeline.
   */
  shiftReader?: ShiftReader;
  now?: () => Date;
  generateEodId?: () => string;
}

export interface CloseInput {
  merchantId: string;
  outletId: string;
  businessDate: string;
  countedCashIdr: number;
  varianceReason: string | null;
  clientSaleIds: readonly string[];
}

export class EodService {
  private readonly salesReader: SalesReader;
  private readonly eodRepository: EodRepository;
  private readonly syntheticReconciler: EodSyntheticReconciler | null;
  private readonly shiftReader: ShiftReader | null;
  private readonly now: () => Date;
  private readonly generateEodId: () => string;

  constructor(deps: EodServiceDeps) {
    this.salesReader = deps.salesReader;
    this.eodRepository = deps.eodRepository;
    this.syntheticReconciler = deps.syntheticReconciler ?? null;
    this.shiftReader = deps.shiftReader ?? null;
    this.now = deps.now ?? (() => new Date());
    this.generateEodId = deps.generateEodId ?? uuidv7;
  }

  async close(input: CloseInput): Promise<EodRecord> {
    const existing = await this.eodRepository.findExisting({
      merchantId: input.merchantId,
      outletId: input.outletId,
      businessDate: input.businessDate,
    });
    if (existing) {
      throw new EodError(
        "eod_already_closed",
        `End of day for ${input.outletId} on ${input.businessDate} is already closed.`,
      );
    }

    const serverSales = await this.salesReader.listSalesByBusinessDate({
      merchantId: input.merchantId,
      outletId: input.outletId,
      businessDate: input.businessDate,
    });
    const serverIds = new Set(serverSales.map((s) => s.localSaleId));

    const missingSaleIds = input.clientSaleIds.filter((id) => !serverIds.has(id));
    if (missingSaleIds.length > 0) {
      throw new EodError(
        "eod_sale_mismatch",
        `${missingSaleIds.length} sale(s) the client queued are not present on the server.`,
        {
          expectedCount: input.clientSaleIds.length,
          receivedCount: input.clientSaleIds.length - missingSaleIds.length,
          missingSaleIds,
        },
      );
    }

    // KASA-151: synthetic-tender (KASA-71 probe) sales never reach the
    // merchant-facing breakdown / expected-cash / variance numbers.
    // Filter them out once and feed the merchant view to the existing
    // reducers; we'll reconcile their stock side-effects below.
    const merchantSales = serverSales.filter((s) => !s.synthetic);
    const syntheticSales = serverSales.filter((s) => s.synthetic);

    // KASA-235 — pull the opening float for this (outlet, businessDate).
    // The shift's `opening_float_idr` pre-funds the drawer, so EOD must
    // include it in expected cash; without it the variance always
    // reflects the float and can never hit zero. Days with no shift
    // record default to zero — the pre-KASA-235 behaviour.
    const shiftRecord = this.shiftReader
      ? await this.shiftReader.findShiftForBusinessDate({
          merchantId: input.merchantId,
          outletId: input.outletId,
          businessDate: input.businessDate,
        })
      : null;
    const openingFloatIdr = shiftRecord?.openingFloatIdr ?? 0;

    const breakdown = computeBreakdown(merchantSales);
    const expectedCashIdr = computeExpectedCash(merchantSales) + openingFloatIdr;
    const varianceIdr = input.countedCashIdr - expectedCashIdr;

    if (varianceIdr !== 0) {
      const reason = input.varianceReason?.trim() ?? "";
      if (reason.length === 0) {
        throw new EodError(
          "eod_variance_reason_required",
          "A variance reason is required when counted cash does not match expected cash.",
        );
      }
    }

    const closedAt = this.now().toISOString();

    // KASA-151: balance every synthetic sale's stock movement before the
    // EOD record lands. The reconciler is idempotent on (saleIds, occurredAt)
    // so a retried close after a partial failure does not double-write the
    // balancing entries. v0 in-memory runs sequentially; the future Postgres
    // impl will scope both writes to one transaction.
    if (syntheticSales.length > 0 && this.syntheticReconciler) {
      await this.syntheticReconciler.reconcileSyntheticSales({
        saleIds: syntheticSales.map((s) => s.saleId),
        occurredAt: closedAt,
      });
    }

    const record: EodRecord = {
      id: this.generateEodId(),
      outletId: input.outletId,
      merchantId: input.merchantId,
      businessDate: input.businessDate,
      closedAt,
      countedCashIdr: input.countedCashIdr,
      expectedCashIdr,
      openingFloatIdr,
      varianceIdr,
      varianceReason: input.varianceReason,
      breakdown,
      clientSaleIds: [...input.clientSaleIds],
    };

    return this.eodRepository.insert(record);
  }

  /**
   * Look up a previously-closed EOD by its server id, scoped to the
   * authenticated merchant. Throws `eod_not_found` when the id is unknown
   * or belongs to a different tenant — both are rendered as 404 by the
   * route handler so callers cannot probe for cross-tenant ids.
   */
  async get(input: { merchantId: string; eodId: string }): Promise<EodRecord> {
    const record = await this.eodRepository.findById({
      merchantId: input.merchantId,
      eodId: input.eodId,
    });
    if (!record) {
      throw new EodError("eod_not_found", `EOD ${input.eodId} not found.`);
    }
    return record;
  }
}

function computeBreakdown(sales: readonly SaleRecord[]): EodRecordBreakdown {
  let cashIdr = 0;
  let qrisDynamicIdr = 0;
  let qrisStaticIdr = 0;
  let qrisStaticUnverifiedIdr = 0;
  let qrisStaticUnverifiedCount = 0;
  let cardIdr = 0;
  let otherIdr = 0;
  let netIdr = 0;
  let taxIdr = 0;
  let voidCount = 0;
  let saleCount = 0;
  for (const sale of sales) {
    if (sale.voidedAt !== null) {
      voidCount += 1;
      continue;
    }
    saleCount += 1;
    netIdr += sale.totalIdr;
    taxIdr += sale.taxIdr;
    const nonCash = sumNonCashTenders(sale.tenders);
    const cashTaken = clampCashTaken(sale.totalIdr, nonCash);
    cashIdr += cashTaken;
    for (const tender of sale.tenders) {
      switch (tender.method) {
        case "cash":
          break; // already accounted via cashTaken
        case "qris_dynamic":
          qrisDynamicIdr += tender.amountIdr;
          break;
        case "qris_static":
          qrisStaticIdr += tender.amountIdr;
          if (!tender.verified) {
            qrisStaticUnverifiedIdr += tender.amountIdr;
            qrisStaticUnverifiedCount += 1;
          }
          break;
        case "card":
          cardIdr += tender.amountIdr;
          break;
        case "other":
          otherIdr += tender.amountIdr;
          break;
      }
    }
  }
  return {
    saleCount,
    voidCount,
    cashIdr,
    qrisDynamicIdr,
    qrisStaticIdr,
    qrisStaticUnverifiedIdr,
    qrisStaticUnverifiedCount,
    cardIdr,
    otherIdr,
    netIdr,
    taxIdr,
  };
}

function computeExpectedCash(sales: readonly SaleRecord[]): number {
  let expected = 0;
  for (const sale of sales) {
    if (sale.voidedAt !== null) continue;
    const nonCash = sumNonCashTenders(sale.tenders);
    expected += clampCashTaken(sale.totalIdr, nonCash);
  }
  return expected;
}

function sumNonCashTenders(tenders: readonly SaleTender[]): number {
  let total = 0;
  for (const tender of tenders) {
    if (tender.method !== "cash") total += tender.amountIdr;
  }
  return total;
}

/**
 * A cash tender amount can exceed the sale total (clerk hands back change),
 * so we infer "cash actually kept in the drawer" from the total minus what
 * other tenders covered. Clamped to [0, total] — a misconfigured tender set
 * must not produce a negative expected cash.
 */
function clampCashTaken(totalIdr: number, nonCashIdr: number): number {
  const cash = totalIdr - nonCashIdr;
  if (cash <= 0) return 0;
  if (cash > totalIdr) return totalIdr;
  return cash;
}
