import { uuidv7 } from "../../lib/uuid.js";
import type { Item, ItemAvailability } from "../../db/schema/items.js";
import {
  type BulkUpsertItemsRow,
  BulkUpsertItemsRowError,
  type CreateItemInput,
  type ItemsRepository,
  type UpdateItemInput,
} from "./repository.js";

export const DEFAULT_ITEM_PAGE_LIMIT = 100;
export const MAX_ITEM_PAGE_LIMIT = 500;

export type ItemErrorCode =
  | "item_not_found"
  | "item_code_conflict"
  | "uom_not_found"
  | "bom_not_found"
  | "invalid_page_token";

export class ItemError extends Error {
  constructor(
    readonly code: ItemErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ItemError";
  }
}

/**
 * Thrown by the Pg implementation when the unique `(merchant_id, code)` index
 * is violated (SQLSTATE `23505`). The service catches it and rethrows as
 * `ItemError("item_code_conflict")`. In-memory impls should throw this same
 * class so the service layer stays DB-agnostic.
 */
export class ItemCodeConflictError extends Error {
  constructor(public readonly code: string) {
    super(`item with code ${code} already exists`);
    this.name = "ItemCodeConflictError";
  }
}

export type ItemForeignKeyTarget = "uom_not_found" | "bom_not_found";

/**
 * Thrown by the Pg implementation when a write trips an FK constraint on
 * `items.uom_id` / `items.bom_id` (SQLSTATE `23503`) — the TOCTOU window
 * between `findUom`/`findBom` and the `INSERT`/`UPDATE`. The service rethrows
 * this as `ItemError("uom_not_found" | "bom_not_found")` so the route emits
 * 404 instead of leaking a 500.
 */
export class ItemForeignKeyError extends Error {
  constructor(
    public readonly target: ItemForeignKeyTarget,
    public readonly id: string,
  ) {
    super(`item references missing ${target === "uom_not_found" ? "uom" : "bom"} ${id}`);
    this.name = "ItemForeignKeyError";
  }
}

export interface ItemsServiceDeps {
  repository: ItemsRepository;
  now?: () => Date;
  generateId?: () => string;
}

export interface CreateItemCommand {
  merchantId: string;
  code: string;
  name: string;
  priceIdr: number;
  uomId: string;
  bomId?: string | null | undefined;
  isStockTracked?: boolean | undefined;
  /** KASA-218 — integer percent (0..100); defaults to 11 (statutory PPN). */
  taxRate?: number | undefined;
  /** KASA-248 — defaults to `available`. */
  availability?: ItemAvailability | undefined;
  isActive?: boolean | undefined;
}

export interface UpdateItemCommand {
  merchantId: string;
  id: string;
  patch: UpdateItemInput["patch"];
}

export interface ListItemsCommand {
  merchantId: string;
  updatedAfter?: Date | undefined;
  pageToken?: string | undefined;
  limit?: number | undefined;
}

export interface BulkUpsertItemsCommand {
  merchantId: string;
  items: ReadonlyArray<BulkUpsertItemsRow>;
}

export interface BulkUpsertItemsRowOutcome {
  index: number;
  code: string;
  status: "created" | "updated" | "unchanged";
  item: Item;
}

export interface BulkUpsertItemsOutcome {
  rows: BulkUpsertItemsRowOutcome[];
  summary: { created: number; updated: number; unchanged: number };
}

/**
 * Maximum batch size. Mirrors `catalogItemBulkUpsertRequest.items.max(500)` in
 * `@kassa/schemas` — the schema gate catches over-limit batches first, but a
 * service-side `MAX_BULK_UPSERT_ITEMS` keeps callers that bypass the schema
 * (e.g. test harnesses) from issuing pathological batches.
 */
export const MAX_BULK_UPSERT_ITEMS = 500;

/**
 * Page tokens are opaque server-issued strings; we use a minimal JSON payload
 * `{ "a": <updated_at iso>, "i": <uuid> }` base64url-encoded. The client only
 * needs to round-trip it. Decoding validates shape so a tampered token
 * surfaces as a 400 instead of leaking a stack trace.
 */
interface PageTokenPayload {
  a: string;
  i: string;
}

function encodePageToken(payload: PageTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePageToken(token: string): PageTokenPayload {
  let raw: string;
  try {
    raw = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new ItemError("invalid_page_token", "Malformed page token.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ItemError("invalid_page_token", "Malformed page token.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).a !== "string" ||
    typeof (parsed as Record<string, unknown>).i !== "string"
  ) {
    throw new ItemError("invalid_page_token", "Malformed page token.");
  }
  const payload = parsed as PageTokenPayload;
  if (Number.isNaN(Date.parse(payload.a))) {
    throw new ItemError("invalid_page_token", "Malformed page token.");
  }
  return payload;
}

export class ItemsService {
  private readonly repository: ItemsRepository;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(deps: ItemsServiceDeps) {
    this.repository = deps.repository;
    this.now = deps.now ?? (() => new Date());
    this.generateId = deps.generateId ?? uuidv7;
  }

  async create(cmd: CreateItemCommand): Promise<Item> {
    // Validate FK targets up front so the handler can return a 404 rather
    // than letting the FK violation bubble up as a 500.
    const uom = await this.repository.findUom({
      id: cmd.uomId,
      merchantId: cmd.merchantId,
    });
    if (!uom) {
      throw new ItemError("uom_not_found", `No uom ${cmd.uomId} for this merchant.`);
    }
    if (cmd.bomId) {
      const bom = await this.repository.findBom({
        id: cmd.bomId,
        merchantId: cmd.merchantId,
      });
      if (!bom) {
        throw new ItemError("bom_not_found", `No bom ${cmd.bomId} for this merchant.`);
      }
    }

    const input: CreateItemInput = {
      id: this.generateId(),
      merchantId: cmd.merchantId,
      code: cmd.code,
      name: cmd.name,
      priceIdr: cmd.priceIdr,
      uomId: cmd.uomId,
      ...(cmd.bomId !== undefined ? { bomId: cmd.bomId } : {}),
      ...(cmd.isStockTracked !== undefined ? { isStockTracked: cmd.isStockTracked } : {}),
      ...(cmd.taxRate !== undefined ? { taxRate: cmd.taxRate } : {}),
      ...(cmd.availability !== undefined ? { availability: cmd.availability } : {}),
      ...(cmd.isActive !== undefined ? { isActive: cmd.isActive } : {}),
      now: this.now(),
    };

    try {
      return await this.repository.createItem(input);
    } catch (err) {
      if (err instanceof ItemCodeConflictError) {
        throw new ItemError("item_code_conflict", `Code ${cmd.code} is already in use.`);
      }
      if (err instanceof ItemForeignKeyError) {
        throw new ItemError(
          err.target,
          err.target === "uom_not_found"
            ? `No uom ${err.id} for this merchant.`
            : `No bom ${err.id} for this merchant.`,
        );
      }
      throw err;
    }
  }

  async get(input: { merchantId: string; id: string }): Promise<Item> {
    const row = await this.repository.findItem(input);
    if (!row) {
      throw new ItemError("item_not_found", `No item ${input.id}.`);
    }
    return row;
  }

  async list(cmd: ListItemsCommand): Promise<{
    records: Item[];
    nextCursor: Date | null;
    nextPageToken: string | null;
  }> {
    const rawLimit = cmd.limit ?? DEFAULT_ITEM_PAGE_LIMIT;
    const limit = Math.max(1, Math.min(MAX_ITEM_PAGE_LIMIT, rawLimit));

    // `pageToken` wins when both are present; it encodes the exact (updatedAt,
    // id) boundary that `updatedAfter` is coarser about. Decoding lives at the
    // service boundary so repos receive a parsed cursor and never touch the
    // opaque wire format.
    let updatedAfter: Date | undefined;
    let cursor: { updatedAt: string; id: string } | undefined;
    if (cmd.pageToken) {
      const payload = decodePageToken(cmd.pageToken);
      cursor = { updatedAt: payload.a, id: payload.i };
    } else if (cmd.updatedAfter) {
      updatedAfter = cmd.updatedAfter;
    }

    const result = await this.repository.listItems({
      merchantId: cmd.merchantId,
      ...(updatedAfter !== undefined ? { updatedAfter } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
    });

    let nextCursor: Date | null = null;
    let nextPageToken: string | null = null;
    if (result.nextBoundary) {
      if (result.hasMore) {
        nextPageToken = encodePageToken({
          a: result.nextBoundary.updatedAtIso,
          i: result.nextBoundary.id,
        });
      } else {
        nextCursor = new Date(result.nextBoundary.updatedAtIso);
      }
    }

    return { records: result.records, nextCursor, nextPageToken };
  }

  async update(cmd: UpdateItemCommand): Promise<Item> {
    if (cmd.patch.uomId !== undefined) {
      const uom = await this.repository.findUom({
        id: cmd.patch.uomId,
        merchantId: cmd.merchantId,
      });
      if (!uom) {
        throw new ItemError("uom_not_found", `No uom ${cmd.patch.uomId} for this merchant.`);
      }
    }
    if (cmd.patch.bomId) {
      const bom = await this.repository.findBom({
        id: cmd.patch.bomId,
        merchantId: cmd.merchantId,
      });
      if (!bom) {
        throw new ItemError("bom_not_found", `No bom ${cmd.patch.bomId} for this merchant.`);
      }
    }

    try {
      const row = await this.repository.updateItem({
        id: cmd.id,
        merchantId: cmd.merchantId,
        patch: cmd.patch,
        now: this.now(),
      });
      if (!row) {
        throw new ItemError("item_not_found", `No item ${cmd.id}.`);
      }
      return row;
    } catch (err) {
      if (err instanceof ItemCodeConflictError) {
        throw new ItemError(
          "item_code_conflict",
          `Code ${cmd.patch.code ?? "?"} is already in use.`,
        );
      }
      if (err instanceof ItemForeignKeyError) {
        throw new ItemError(
          err.target,
          err.target === "uom_not_found"
            ? `No uom ${err.id} for this merchant.`
            : `No bom ${err.id} for this merchant.`,
        );
      }
      throw err;
    }
  }

  async softDelete(input: { merchantId: string; id: string }): Promise<void> {
    const row = await this.repository.softDeleteItem({
      id: input.id,
      merchantId: input.merchantId,
      now: this.now(),
    });
    if (!row) {
      throw new ItemError("item_not_found", `No item ${input.id}.`);
    }
  }

  /**
   * Atomic create-or-update for a CSV-import batch (KASA-311). Pre-validates
   * each row's FK targets (UoM / BOM) so a missing reference surfaces as a
   * 404-shape error without ever opening the transaction. The repository
   * call owns the transactional rollback so partial inserts cannot leak.
   *
   * Idempotent on `code`: a re-imported row whose persisted fields match the
   * stored row is returned with `status: "unchanged"` and no row is written.
   */
  async bulkUpsert(cmd: BulkUpsertItemsCommand): Promise<BulkUpsertItemsOutcome> {
    if (cmd.items.length === 0) {
      return { rows: [], summary: { created: 0, updated: 0, unchanged: 0 } };
    }
    if (cmd.items.length > MAX_BULK_UPSERT_ITEMS) {
      throw new ItemError(
        "invalid_page_token",
        `bulk batch over ${MAX_BULK_UPSERT_ITEMS} rows is rejected.`,
      );
    }

    // Fan-out unique FK targets so we make at most one lookup per id. This
    // keeps the staging-time-budget AC (`100-row import under 5s`) tight by
    // capping FK round-trips at O(distinct uoms + distinct boms) rather than
    // O(rows). The repo's transactional path is the durable guard against
    // mid-flight FK breakage (TOCTOU); these checks just give us a clean
    // per-row error message before opening the txn.
    const uomIds = new Set<string>();
    const bomIds = new Set<string>();
    for (const row of cmd.items) {
      uomIds.add(row.uomId);
      if (row.bomId) bomIds.add(row.bomId);
    }
    for (const id of uomIds) {
      const found = await this.repository.findUom({ id, merchantId: cmd.merchantId });
      if (!found) {
        const idx = cmd.items.findIndex((r) => r.uomId === id);
        const err = new ItemError("uom_not_found", `No uom ${id} for this merchant.`);
        (err as ItemError & { rowIndex?: number }).rowIndex = idx;
        throw err;
      }
    }
    for (const id of bomIds) {
      const found = await this.repository.findBom({ id, merchantId: cmd.merchantId });
      if (!found) {
        const idx = cmd.items.findIndex((r) => r.bomId === id);
        const err = new ItemError("bom_not_found", `No bom ${id} for this merchant.`);
        (err as ItemError & { rowIndex?: number }).rowIndex = idx;
        throw err;
      }
    }

    try {
      const result = await this.repository.bulkUpsertItems({
        merchantId: cmd.merchantId,
        rows: cmd.items,
        generateId: this.generateId,
        now: this.now(),
      });
      const summary = { created: 0, updated: 0, unchanged: 0 };
      for (const row of result.rows) summary[row.status] += 1;
      return { rows: result.rows, summary };
    } catch (err) {
      if (err instanceof BulkUpsertItemsRowError) {
        const wrapped = new ItemError(
          err.target,
          err.target === "uom_not_found"
            ? `No uom ${err.id} for this merchant.`
            : `No bom ${err.id} for this merchant.`,
        );
        (wrapped as ItemError & { rowIndex?: number }).rowIndex = err.index;
        throw wrapped;
      }
      if (err instanceof ItemCodeConflictError) {
        throw new ItemError("item_code_conflict", `Code ${err.code} is already in use.`);
      }
      throw err;
    }
  }
}

export function toItemResponse(row: Item): {
  id: string;
  code: string;
  name: string;
  priceIdr: number;
  uomId: string;
  bomId: string | null;
  isStockTracked: boolean;
  taxRate: number;
  availability: ItemAvailability;
  isActive: boolean;
  updatedAt: string;
} {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    priceIdr: row.priceIdr,
    uomId: row.uomId,
    bomId: row.bomId,
    isStockTracked: row.isStockTracked,
    taxRate: row.taxRate,
    availability: row.availability,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function encodeItemPageToken(row: Item): string {
  return encodePageToken({ a: row.updatedAt.toISOString(), i: row.id });
}
