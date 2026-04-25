import type { EodDataPlane, UpsertSaleInput, UpsertSaleOutcome } from "./repository.js";
import type { EodRecord, SaleRecord } from "./types.js";

function saleKey(merchantId: string, localSaleId: string): string {
  return `${merchantId}::${localSaleId}`;
}

function eodKey(merchantId: string, outletId: string, businessDate: string): string {
  return `${merchantId}::${outletId}::${businessDate}`;
}

/**
 * Process-local, unsynchronised. Fine for single-instance dev + tests; every
 * production deployment will swap this for the Drizzle-backed plane in
 * KASA-21.
 */
export class InMemoryEodDataPlane implements EodDataPlane {
  private readonly salesByKey = new Map<string, SaleRecord>();
  private readonly eodsByKey = new Map<string, EodRecord>();

  async upsertSale(input: UpsertSaleInput): Promise<UpsertSaleOutcome> {
    const key = saleKey(input.record.merchantId, input.record.localSaleId);
    const existing = this.salesByKey.get(key);
    if (existing) {
      return { status: "duplicate", existing };
    }
    this.salesByKey.set(key, input.record);
    return { status: "created", record: input.record };
  }

  async listForClose(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<readonly SaleRecord[]> {
    const matches: SaleRecord[] = [];
    for (const sale of this.salesByKey.values()) {
      if (
        sale.merchantId === input.merchantId &&
        sale.outletId === input.outletId &&
        sale.businessDate === input.businessDate
      ) {
        matches.push(sale);
      }
    }
    // Stable order by createdAt for deterministic breakdown rollups.
    return matches.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async findExisting(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<EodRecord | null> {
    return this.eodsByKey.get(eodKey(input.merchantId, input.outletId, input.businessDate)) ?? null;
  }

  async insert(record: EodRecord): Promise<EodRecord> {
    const key = eodKey(record.merchantId, record.outletId, record.businessDate);
    if (this.eodsByKey.has(key)) {
      // Lock enforcement is a contract the service already checked before
      // calling insert; treat a race here as a programmer error.
      throw new Error(`EOD already exists for ${key}`);
    }
    this.eodsByKey.set(key, record);
    return record;
  }

  // Test helper — not part of the data-plane contract.
  _seedSale(record: SaleRecord): void {
    this.salesByKey.set(saleKey(record.merchantId, record.localSaleId), record);
  }
}
