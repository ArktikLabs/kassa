import type { Merchant } from "../../db/schema/merchants.js";

/**
 * Partial-update payload for the merchant settings columns introduced by
 * KASA-219. Each field is independently `undefined` (preserve), `null`
 * (clear), or a string (set). Length / format validation lives in
 * `@kassa/schemas/merchant` — repositories store whatever they receive.
 *
 * `displayName` cannot be cleared once set: callers must pass a non-empty
 * string when the field is present. The route layer enforces this via the
 * `merchantSettingsUpdateRequest` schema.
 */
export interface MerchantSettingsUpdate {
  displayName?: string | undefined;
  addressLine?: string | null | undefined;
  phone?: string | null | undefined;
  npwp?: string | null | undefined;
  receiptFooterText?: string | null | undefined;
}

/**
 * Data plane for the `merchants` aggregate. KASA-221 only needs single-row
 * read + partial update (the back-office settings page); list / cursor
 * semantics belong on `outlets`, not here.
 */
export interface MerchantsRepository {
  findById(merchantId: string): Promise<Merchant | null>;
  /**
   * Apply a partial update to the merchant row. Returns the updated row, or
   * `null` when no merchant matches (the caller surfaces this as 404).
   * Implementations must bump `updated_at` so the POS sync runner can window
   * the read-through cache.
   */
  updateSettings(merchantId: string, update: MerchantSettingsUpdate): Promise<Merchant | null>;
}
