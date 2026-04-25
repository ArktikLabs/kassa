import type { Item } from "../../db/schema/items.js";

export interface CreateItemInput {
  id: string;
  merchantId: string;
  code: string;
  name: string;
  priceIdr: number;
  uomId: string;
  bomId?: string | null;
  isStockTracked?: boolean;
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
    isActive?: boolean;
  };
  now: Date;
}

export interface ListItemsInput {
  merchantId: string;
  updatedAfter?: Date;
  pageToken?: string | null;
  limit: number;
}

export interface ListItemsResult {
  records: Item[];
  nextCursor: Date | null;
  nextPageToken: string | null;
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
