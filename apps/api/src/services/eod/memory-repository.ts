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
  private readonly eodsById = new Map<string, EodRecord>();

  async findExisting(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<EodRecord | null> {
    return this.eodsByKey.get(eodKey(input.merchantId, input.outletId, input.businessDate)) ?? null;
  }

  async findById(input: { merchantId: string; eodId: string }): Promise<EodRecord | null> {
    const record = this.eodsById.get(input.eodId);
    if (!record) return null;
    // Tenant scope guard: a leaked / guessed id from one merchant must
    // never resolve to another merchant's record.
    if (record.merchantId !== input.merchantId) return null;
    return record;
  }

  async insert(record: EodRecord): Promise<EodRecord> {
    const key = eodKey(record.merchantId, record.outletId, record.businessDate);
    if (this.eodsByKey.has(key)) {
      // Lock enforcement is a contract the service already checked before
      // calling insert; treat a race here as a programmer error.
      throw new Error(`EOD already exists for ${key}`);
    }
    this.eodsByKey.set(key, record);
    this.eodsById.set(record.id, record);
    return record;
  }
}
