import type { EodRepository } from "./repository.js";
import type { EodRecord } from "./types.js";

function eodKey(merchantId: string, outletId: string, businessDate: string): string {
  return `${merchantId}::${outletId}::${businessDate}`;
}

/**
 * Process-local, unsynchronised. Fine for single-instance dev + tests; every
 * production deployment will swap this for the Drizzle-backed impl in KASA-21.
 */
export class InMemoryEodRepository implements EodRepository {
  private readonly eodsByKey = new Map<string, EodRecord>();

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
}
