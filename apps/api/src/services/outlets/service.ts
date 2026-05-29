import type { Outlet } from "../../db/schema/outlets.js";
import { InvalidPageTokenError, decodePageToken } from "../../lib/page-token.js";
import type { ListOutletsResult, OutletsRepository } from "./repository.js";

export const DEFAULT_OUTLET_PAGE_LIMIT = 100;
export const MAX_OUTLET_PAGE_LIMIT = 500;

export type OutletErrorCode = "invalid_page_token" | "outlet_not_found";

export class OutletError extends Error {
  constructor(
    readonly code: OutletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OutletError";
  }
}

export interface OutletsServiceDeps {
  repository: OutletsRepository;
}

export interface ListOutletsCommand {
  merchantId: string;
  updatedAfter?: Date | undefined;
  pageToken?: string | undefined;
  limit?: number | undefined;
}

/**
 * KASA-367 — `PATCH /v1/outlets/:outletId`. `merchantId` scopes the row so
 * a cross-tenant id resolves the same as an unknown id (404). Each field
 * is tri-state: `undefined` leaves the column unchanged, `null` clears it,
 * a string overwrites. The `updatedAt` bump is delegated to the repository
 * so both backings stamp the same cursor semantics the delta-pull relies on.
 */
export interface UpdateOutletCommand {
  merchantId: string;
  outletId: string;
  patch: {
    displayName?: string | null | undefined;
    addressLine1?: string | null | undefined;
    addressLine2?: string | null | undefined;
    taxId?: string | null | undefined;
    receiptFooterLine1?: string | null | undefined;
    receiptFooterLine2?: string | null | undefined;
  };
}

export class OutletsService {
  private readonly repository: OutletsRepository;

  constructor(deps: OutletsServiceDeps) {
    this.repository = deps.repository;
  }

  /**
   * Resolve a single outlet by id, scoped to `merchantId`. Returns `null`
   * for unknown ids and for ids that belong to another tenant. Added for
   * the KASA-250 EOD CSV export, which needs the outlet's display name +
   * `code` slug.
   */
  async findById(input: { merchantId: string; outletId: string }): Promise<Outlet | null> {
    return this.repository.findById(input);
  }

  async list(cmd: ListOutletsCommand): Promise<ListOutletsResult> {
    const rawLimit = cmd.limit ?? DEFAULT_OUTLET_PAGE_LIMIT;
    const limit = Math.max(1, Math.min(MAX_OUTLET_PAGE_LIMIT, rawLimit));

    let updatedAfter: Date | undefined;
    let pageToken: string | null = null;
    if (cmd.pageToken) {
      try {
        const payload = decodePageToken(cmd.pageToken);
        updatedAfter = new Date(payload.a);
        pageToken = cmd.pageToken;
      } catch (err) {
        if (err instanceof InvalidPageTokenError) {
          throw new OutletError("invalid_page_token", err.message);
        }
        throw err;
      }
    } else if (cmd.updatedAfter) {
      updatedAfter = cmd.updatedAfter;
    }

    return this.repository.listOutlets({
      merchantId: cmd.merchantId,
      ...(updatedAfter !== undefined ? { updatedAfter } : {}),
      pageToken,
      limit,
    });
  }

  async update(cmd: UpdateOutletCommand): Promise<Outlet> {
    const updated = await this.repository.updateOutlet({
      merchantId: cmd.merchantId,
      outletId: cmd.outletId,
      patch: cmd.patch,
    });
    if (!updated) {
      throw new OutletError("outlet_not_found", "Outlet not found.");
    }
    return updated;
  }
}

export function toOutletResponse(row: Outlet): {
  id: string;
  code: string;
  name: string;
  timezone: string;
  displayName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  taxId: string | null;
  receiptFooterLine1: string | null;
  receiptFooterLine2: string | null;
  updatedAt: string;
} {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    timezone: row.timezone,
    displayName: row.displayName ?? null,
    addressLine1: row.addressLine1 ?? null,
    addressLine2: row.addressLine2 ?? null,
    taxId: row.taxId ?? null,
    receiptFooterLine1: row.receiptFooterLine1 ?? null,
    receiptFooterLine2: row.receiptFooterLine2 ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
