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
}
