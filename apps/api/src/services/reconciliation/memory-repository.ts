import type {
  ManualMatchInput,
  ManualMatchOutcome,
  ReconciliationRepository,
} from "./repository.js";
import type { ReconciliationMatch, UnverifiedStaticQrisTender } from "./types.js";

/**
 * In-memory ReconciliationRepository for the unit suite. Holds an array
 * of tenders and the set of ones already marked verified; mutates in place
 * so a test that runs reconciliation twice can assert idempotency.
 */
export class InMemoryReconciliationRepository implements ReconciliationRepository {
  private readonly tenders = new Map<string, StoredTender>();
  private readonly verifiedTenderIds = new Set<string>();
  private readonly manualMatchAudit: ManualMatchAuditEntry[] = [];

  seedTender(input: StoredTender): void {
    this.tenders.set(input.tenderId, { ...input });
  }

  isVerified(tenderId: string): boolean {
    return this.verifiedTenderIds.has(tenderId);
  }

  manualMatchAuditFor(tenderId: string): readonly ManualMatchAuditEntry[] {
    return this.manualMatchAudit.filter((entry) => entry.tenderId === tenderId);
  }

  async listUnverifiedStaticQrisTenders(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<readonly UnverifiedStaticQrisTender[]> {
    const out: UnverifiedStaticQrisTender[] = [];
    for (const tender of this.tenders.values()) {
      if (tender.merchantId !== input.merchantId) continue;
      if (tender.outletId !== input.outletId) continue;
      if (tender.businessDate !== input.businessDate) continue;
      if (this.verifiedTenderIds.has(tender.tenderId)) continue;
      out.push({
        tenderId: tender.tenderId,
        saleId: tender.saleId,
        outletId: tender.outletId,
        amountIdr: tender.amountIdr,
        buyerRefLast4: tender.buyerRefLast4,
        saleCreatedAt: tender.saleCreatedAt,
      });
    }
    return out;
  }

  async markMatched(matches: readonly ReconciliationMatch[]): Promise<number> {
    let flipped = 0;
    for (const match of matches) {
      if (this.verifiedTenderIds.has(match.tenderId)) continue; // idempotent
      if (!this.tenders.has(match.tenderId)) continue;
      this.verifiedTenderIds.add(match.tenderId);
      flipped += 1;
    }
    return flipped;
  }

  async manualMatch(input: ManualMatchInput): Promise<ManualMatchOutcome> {
    const tender = this.tenders.get(input.tenderId);
    if (!tender || tender.merchantId !== input.merchantId) return "not_found";
    if (this.verifiedTenderIds.has(input.tenderId)) return "already_verified";
    this.verifiedTenderIds.add(input.tenderId);
    this.manualMatchAudit.push({
      tenderId: input.tenderId,
      providerTransactionId: input.providerTransactionId,
      note: input.note,
      staffUserId: input.staffUserId,
      matchedAt: input.matchedAt,
    });
    return "flipped";
  }
}

export interface ManualMatchAuditEntry {
  tenderId: string;
  providerTransactionId: string | null;
  note: string;
  staffUserId: string;
  matchedAt: string;
}

export interface StoredTender {
  tenderId: string;
  saleId: string;
  merchantId: string;
  outletId: string;
  businessDate: string;
  amountIdr: number;
  buyerRefLast4: string;
  saleCreatedAt: string;
}
