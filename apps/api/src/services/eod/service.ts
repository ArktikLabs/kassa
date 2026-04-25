import type { EodMissingSalesDetails } from "@kassa/schemas/eod";
import { uuidv7 } from "../../lib/uuid.js";
import type { EodRepository, SalesReader } from "./repository.js";
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
    readonly code: "eod_already_closed" | "eod_sale_mismatch" | "eod_variance_reason_required",
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
  private readonly now: () => Date;
  private readonly generateEodId: () => string;

  constructor(deps: EodServiceDeps) {
    this.salesReader = deps.salesReader;
    this.eodRepository = deps.eodRepository;
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

    const breakdown = computeBreakdown(serverSales);
    const expectedCashIdr = computeExpectedCash(serverSales);
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

    const record: EodRecord = {
      id: this.generateEodId(),
      outletId: input.outletId,
      merchantId: input.merchantId,
      businessDate: input.businessDate,
      closedAt: this.now().toISOString(),
      countedCashIdr: input.countedCashIdr,
      expectedCashIdr,
      varianceIdr,
      varianceReason: input.varianceReason,
      breakdown,
      clientSaleIds: [...input.clientSaleIds],
    };

    return this.eodRepository.insert(record);
  }
}

function computeBreakdown(sales: readonly SaleRecord[]): EodRecordBreakdown {
  let cashIdr = 0;
  let qrisDynamicIdr = 0;
  let qrisStaticIdr = 0;
  let cardIdr = 0;
  let otherIdr = 0;
  let netIdr = 0;
  let voidCount = 0;
  let saleCount = 0;
  for (const sale of sales) {
    if (sale.voidedAt !== null) {
      voidCount += 1;
      continue;
    }
    saleCount += 1;
    netIdr += sale.totalIdr;
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
    cardIdr,
    otherIdr,
    netIdr,
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
