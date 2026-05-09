import type { Merchant } from "../../db/schema/merchants.js";
import type {
  MerchantSettingsUpdate,
  MerchantsRepository,
} from "./repository.js";

export interface SeedMerchantInput {
  id: string;
  name: string;
  timezone?: string;
  taxInclusive?: boolean;
  displayName?: string | null;
  addressLine?: string | null;
  phone?: string | null;
  npwp?: string | null;
  receiptFooterText?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory `MerchantsRepository` for tests + bootstrap. Clock is injectable
 * so tests can pin `updatedAt` deterministically across PATCH round-trips.
 */
export class InMemoryMerchantsRepository implements MerchantsRepository {
  private readonly merchants = new Map<string, Merchant>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  seedMerchant(input: SeedMerchantInput): void {
    const row: Merchant = {
      id: input.id,
      name: input.name,
      timezone: input.timezone ?? "Asia/Jakarta",
      taxInclusive: input.taxInclusive ?? true,
      displayName: input.displayName ?? null,
      addressLine: input.addressLine ?? null,
      phone: input.phone ?? null,
      npwp: input.npwp ?? null,
      receiptFooterText: input.receiptFooterText ?? null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
    this.merchants.set(row.id, row);
  }

  async findById(merchantId: string): Promise<Merchant | null> {
    const row = this.merchants.get(merchantId);
    return row ? { ...row } : null;
  }

  async updateSettings(
    merchantId: string,
    update: MerchantSettingsUpdate,
  ): Promise<Merchant | null> {
    const row = this.merchants.get(merchantId);
    if (!row) return null;
    const next: Merchant = {
      ...row,
      ...(update.displayName !== undefined ? { displayName: update.displayName } : {}),
      ...(update.addressLine !== undefined ? { addressLine: update.addressLine } : {}),
      ...(update.phone !== undefined ? { phone: update.phone } : {}),
      ...(update.npwp !== undefined ? { npwp: update.npwp } : {}),
      ...(update.receiptFooterText !== undefined
        ? { receiptFooterText: update.receiptFooterText }
        : {}),
      updatedAt: this.now(),
    };
    this.merchants.set(merchantId, next);
    return { ...next };
  }
}
