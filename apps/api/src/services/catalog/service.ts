import { uuidv7 } from "../../lib/uuid.js";
import type { Item, ItemAvailability } from "../../db/schema/items.js";
import type { CreateItemInput, ItemsRepository, UpdateItemInput } from "./repository.js";

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
