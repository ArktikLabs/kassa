import type { Item, ItemAvailability } from "../../db/schema/items.js";
import type { ItemForeignKeyTarget } from "./service.js";

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
  /**
   * Atomic create-or-update for the bulk CSV import surface (KASA-311). Every
   * row is matched on `(merchantId, code)`; existing rows update only when a
   * persisted field actually changed (idempotent re-import). Implementations
   * must roll back the entire batch on any error so partial inserts do not
   * leak into the merchant's catalog.
   *
   * `BulkUpsertItemsRowError` lets the impl flag a specific row index that
   * tripped an FK constraint (UoM/BOM gone between the service's pre-check
   * and the write) so the service can surface a per-row 422 details payload
   * instead of a uniform 500.
   */
  bulkUpsertItems(input: BulkUpsertItemsInput): Promise<BulkUpsertItemsResult>;
}

export interface BulkUpsertItemsRow {
  code: string;
  name: string;
  priceIdr: number;
  uomId: string;
  bomId?: string | null | undefined;
  isStockTracked?: boolean | undefined;
  isActive?: boolean | undefined;
}

export interface BulkUpsertItemsInput {
  merchantId: string;
  rows: readonly BulkUpsertItemsRow[];
  /**
   * Called per inserted row. Kept as a callback (rather than a list of
   * pre-generated ids) so the repo only burns ids for rows that turn out
   * to need an insert — re-imports of an unchanged file allocate none.
   */
  generateId: () => string;
  now: Date;
}

export interface BulkUpsertItemsRowResult {
  index: number;
  code: string;
  status: "created" | "updated" | "unchanged";
  item: Item;
}

export interface BulkUpsertItemsResult {
  rows: BulkUpsertItemsRowResult[];
}

/**
 * Wraps a repo-level failure tied to a specific input row so the service can
 * decorate a 422 with a row index instead of letting the whole batch surface
 * as a vague 500. `target` distinguishes the FK target hit (UoM / BOM); the
 * service translates that into the public `uom_not_found` / `bom_not_found`
 * codes.
 */
export class BulkUpsertItemsRowError extends Error {
  constructor(
    public readonly index: number,
    public readonly target: ItemForeignKeyTarget,
    public readonly id: string,
  ) {
    super(`bulk upsert row ${index} references missing ${target} ${id}`);
    this.name = "BulkUpsertItemsRowError";
  }
}
