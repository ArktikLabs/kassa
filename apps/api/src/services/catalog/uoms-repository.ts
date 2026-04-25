import type { Uom } from "../../db/schema/uoms.js";

export interface ListUomsInput {
  merchantId: string;
  updatedAfter?: Date;
  pageToken?: string | null;
  limit: number;
}

export interface ListUomsResult {
  records: Uom[];
  nextCursor: Date | null;
  nextPageToken: string | null;
}

/**
 * Data plane for the `uoms` reference table (KASA-122). Reads are
 * merchant-scoped via `uoms.merchantId`. List ordering is `(updatedAt ASC,
 * id ASC)` — matches the `uoms_merchant_updated_at_idx` index.
 */
export interface UomsRepository {
  listUoms(input: ListUomsInput): Promise<ListUomsResult>;
}
