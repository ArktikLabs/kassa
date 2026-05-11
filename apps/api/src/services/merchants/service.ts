import type { MerchantSettings, MerchantMeResponse } from "@kassa/schemas";
import type { Merchant } from "../../db/schema/merchants.js";
import type { MerchantSettingsUpdate, MerchantsRepository } from "./repository.js";

export type MerchantErrorCode = "merchant_not_found";

export class MerchantError extends Error {
  constructor(
    readonly code: MerchantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MerchantError";
  }
}

export interface MerchantsServiceDeps {
  repository: MerchantsRepository;
}

export class MerchantsService {
  private readonly repository: MerchantsRepository;

  constructor(deps: MerchantsServiceDeps) {
    this.repository = deps.repository;
  }

  async getMe(merchantId: string): Promise<MerchantMeResponse> {
    const row = await this.repository.findById(merchantId);
    if (!row) {
      throw new MerchantError("merchant_not_found", `Merchant ${merchantId} not found.`);
    }
    return toMerchantMeResponse(row);
  }

  async updateSettings(
    merchantId: string,
    update: MerchantSettingsUpdate,
  ): Promise<MerchantMeResponse> {
    const row = await this.repository.updateSettings(merchantId, update);
    if (!row) {
      throw new MerchantError("merchant_not_found", `Merchant ${merchantId} not found.`);
    }
    return toMerchantMeResponse(row);
  }
}

/**
 * Build the wire shape from a `merchants` row. `displayName` falls back to
 * the legacy `name` column when the back-office has not yet set the
 * receipt-header value, so a brand-new merchant still prints a header on
 * day one. Other settings fields stay null until edited.
 */
export function toMerchantMeResponse(row: Merchant): MerchantMeResponse {
  const settings: MerchantSettings = {
    displayName: row.displayName ?? row.name,
    addressLine: row.addressLine,
    phone: row.phone,
    npwp: row.npwp,
    receiptFooterText: row.receiptFooterText,
  };
  return {
    id: row.id,
    settings,
    updatedAt: row.updatedAt.toISOString(),
  };
}
