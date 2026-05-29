import type { Outlet } from "../../db/schema/outlets.js";

export interface ListOutletsInput {
  merchantId: string;
  updatedAfter?: Date;
  pageToken?: string | null;
  limit: number;
}

export interface ListOutletsResult {
  records: Outlet[];
  nextCursor: Date | null;
  nextPageToken: string | null;
}

/**
 * KASA-367 — partial PATCH against an outlet. Each field is tri-state:
 *  - `undefined` → column unchanged
 *  - `null` → column cleared
 *  - string → column overwritten
 *
 * `merchantId` scopes the row; an `outletId` belonging to another tenant
 * resolves the same as an unknown id (returns `null`).
 */
export interface UpdateOutletInput {
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

/**
 * Data plane for the `outlets` aggregate (KASA-122).
 *
 * Reads are merchant-scoped; the merchantId comes from the authenticated
 * principal, never the wire. List ordering is `(updatedAt ASC, id ASC)` so
 * cursor + page-token semantics match the Pg index `outlets_merchant_updated_at_idx`.
 */
export interface OutletsRepository {
  listOutlets(input: ListOutletsInput): Promise<ListOutletsResult>;
  /**
   * Resolve a single outlet by id, scoped to `merchantId` so cross-tenant
   * ids never leak. Returns `null` for both "unknown id" and "id belongs
   * to another merchant" — callers map the absence to 404 without
   * revealing whether the id exists. Added for the KASA-250 EOD CSV
   * export, which needs the outlet's display name + slug `code` to
   * render the file and `Content-Disposition` header.
   */
  findById(input: { merchantId: string; outletId: string }): Promise<Outlet | null>;
  /**
   * Apply a partial PATCH and return the updated row. Returns `null` when
   * `outletId` is unknown OR belongs to another tenant (404 semantics).
   * Implementations stamp `updatedAt` so the delta-pull cursor advances
   * and the POS picks up the change on the next sync cycle.
   */
  updateOutlet(input: UpdateOutletInput): Promise<Outlet | null>;
}
