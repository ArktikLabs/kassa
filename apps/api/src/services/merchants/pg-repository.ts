import { eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { type Merchant, merchants } from "../../db/schema/merchants.js";
import type {
  MerchantSettingsUpdate,
  MerchantsRepository,
} from "./repository.js";

/**
 * Drizzle-backed `MerchantsRepository`. The settings PATCH builds an explicit
 * `set` map so a `null` clears the column while an `undefined` field leaves
 * the existing value untouched. `updated_at` is bumped to `NOW()` server-side
 * to match the Pg `timestamptz` precision the POS sync runner reads from.
 */
export class PgMerchantsRepository implements MerchantsRepository {
  constructor(private readonly db: Database) {}

  async findById(merchantId: string): Promise<Merchant | null> {
    const rows = await this.db
      .select()
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateSettings(
    merchantId: string,
    update: MerchantSettingsUpdate,
  ): Promise<Merchant | null> {
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (update.displayName !== undefined) set.displayName = update.displayName;
    if (update.addressLine !== undefined) set.addressLine = update.addressLine;
    if (update.phone !== undefined) set.phone = update.phone;
    if (update.npwp !== undefined) set.npwp = update.npwp;
    if (update.receiptFooterText !== undefined) set.receiptFooterText = update.receiptFooterText;

    const rows = await this.db
      .update(merchants)
      .set(set)
      .where(eq(merchants.id, merchantId))
      .returning();
    return rows[0] ?? null;
  }
}
