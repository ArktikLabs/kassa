import type { Item, ItemAvailability } from "../../db/schema/items.js";

export interface CreateItemInput {
  id: string;
  merchantId: string;
  code: string;
  name: string;
  priceIdr: number;
  uomId: string;
  bomId?: string | null;
  isStockTracked?: boolean;
  /** KASA-218 — integer percent (0..100); defaults to 11 (statutory PPN). */
  taxRate?: number;
  /** KASA-248 — defaults to `available`. */
  availability?: ItemAvailability;
  isActive?: boolean;
  now: Date;
}

export interface UpdateItemInput {
  id: string;
  merchantId: string;
  patch: {
    code?: string;
    name?: string;
    priceIdr?: number;
    uomId?: string;
    bomId?: string | null;
    isStockTracked?: boolean;
    /** KASA-218 — integer percent (0..100). */
    taxRate?: number;
    /** KASA-248 — mid-shift availability flag. */
    availability?: ItemAvailability;
    isActive?: boolean;
  };
  now: Date;
}

export interface ListItemsInput {
  merchantId: string;
  updatedAfter?: Date;
  /**
   * Parsed pagination boundary — rows where `(updated_at, id)` is strictly
   * greater than `(cursor.updatedAt, cursor.id)`. The service decodes the
   * client's opaque page token into this shape so the repo never touches
   * token decoding.
   *
   * `updatedAt` is the same ISO 8601 stamp the repo emitted via
   * `nextBoundary.updatedAtIso` — kept as a string so microsecond precision
   * (which JS `Date` truncates) survives the round-trip into Postgres'
   * `::timestamptz`.
   */
  cursor?: { updatedAt: string; id: string };
  limit: number;
}

export interface ListItemsResult {
  records: Item[];
  /**
   * Boundary at the last row of the page, or `null` when the page is empty.
   * `updatedAtIso` carries microsecond precision so the value can be fed
   * back in as `cursor.updatedAt` without loss. The service decides whether
   * to surface this as the drained `nextCursor` (Date, used as
   * `updatedAfter` next time) or encode it into `nextPageToken`.
   */
  nextBoundary: { updatedAtIso: string; id: string } | null;
  hasMore: boolean;
}

/**
 * Data plane for the catalog `items` aggregate (KASA-23).
 *
 * All reads and writes are merchant-scoped; callers must pass the merchantId
 * derived from the authenticated principal — never trust a body value.
 *
 * Lookups on `uomId` / `bomId` are used to validate writes before the insert
 * hits the FK constraint, so the handler can return a clean 404 instead of
 * a 500 from Postgres error bubbling.
 */
export interface ItemsRepository {
  findItem(input: { id: string; merchantId: string }): Promise<Item | null>;
  listItems(input: ListItemsInput): Promise<ListItemsResult>;
  createItem(input: CreateItemInput): Promise<Item>;
  updateItem(input: UpdateItemInput): Promise<Item | null>;
  /**
   * Soft-delete an item by setting `is_active=false`. Returns the mutated row
   * or `null` if the id does not exist in the merchant's scope. Hard delete is
   * a v1 concern — historical `sale_items` and `bom_components` reference item
   * ids.
   */
  softDeleteItem(input: { id: string; merchantId: string; now: Date }): Promise<Item | null>;
  findUom(input: { id: string; merchantId: string }): Promise<{ id: string } | null>;
  findBom(input: { id: string; merchantId: string }): Promise<{ id: string } | null>;
}
