import type { Item } from "../../db/schema/items.js";
import { ItemCodeConflictError } from "./service.js";
import type {
  CreateItemInput,
  ItemsRepository,
  ListItemsInput,
  ListItemsResult,
  UpdateItemInput,
} from "./repository.js";

interface PageTokenPayload {
  a: string;
  i: string;
}

function decodePageToken(token: string): PageTokenPayload {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as PageTokenPayload;
}

/**
 * In-memory repo for tests. Enforces the same invariants as the Pg impl:
 * unique `(merchantId, code)` and merchant-scoped reads. Ordering for `list`
 * is `(updatedAt ASC, id ASC)` — matches the Pg index and keeps the cursor
 * semantics identical.
 */
export class InMemoryItemsRepository implements ItemsRepository {
  private readonly items = new Map<string, Item>();
  private readonly uoms = new Set<string>();
  private readonly boms = new Set<string>();
  private readonly merchantScopedUoms = new Map<string, Set<string>>();
  private readonly merchantScopedBoms = new Map<string, Set<string>>();

  seedUom(merchantId: string, uomId: string): void {
    this.uoms.add(uomId);
    const set = this.merchantScopedUoms.get(merchantId) ?? new Set<string>();
    set.add(uomId);
    this.merchantScopedUoms.set(merchantId, set);
  }

  seedBom(merchantId: string, bomId: string): void {
    this.boms.add(bomId);
    const set = this.merchantScopedBoms.get(merchantId) ?? new Set<string>();
    set.add(bomId);
    this.merchantScopedBoms.set(merchantId, set);
  }

  async findUom(input: { id: string; merchantId: string }): Promise<{ id: string } | null> {
    const set = this.merchantScopedUoms.get(input.merchantId);
    return set?.has(input.id) ? { id: input.id } : null;
  }

  async findBom(input: { id: string; merchantId: string }): Promise<{ id: string } | null> {
    const set = this.merchantScopedBoms.get(input.merchantId);
    return set?.has(input.id) ? { id: input.id } : null;
  }

  async findItem(input: { id: string; merchantId: string }): Promise<Item | null> {
    const row = this.items.get(input.id);
    if (!row || row.merchantId !== input.merchantId) return null;
    return { ...row };
  }

  async listItems(input: ListItemsInput): Promise<ListItemsResult> {
    let tokenBoundary: { updatedAt: Date; id: string } | null = null;
    if (input.pageToken) {
      const decoded = decodePageToken(input.pageToken);
      tokenBoundary = { updatedAt: new Date(decoded.a), id: decoded.i };
    }
    const updatedAfter = input.updatedAfter;

    const filtered = [...this.items.values()]
      .filter((row) => row.merchantId === input.merchantId)
      .filter((row) => {
        if (tokenBoundary) {
          if (row.updatedAt.getTime() > tokenBoundary.updatedAt.getTime()) return true;
          if (row.updatedAt.getTime() === tokenBoundary.updatedAt.getTime()) {
            return row.id > tokenBoundary.id;
          }
          return false;
        }
        if (updatedAfter) return row.updatedAt.getTime() > updatedAfter.getTime();
        return true;
      })
      .sort((a, b) => {
        const diff = a.updatedAt.getTime() - b.updatedAt.getTime();
        if (diff !== 0) return diff;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

    const page = filtered.slice(0, input.limit);
    const hasMore = filtered.length > input.limit;
    const last = page.at(-1);

    let nextCursor: Date | null = null;
    let nextPageToken: string | null = null;

    if (hasMore && last) {
      nextPageToken = Buffer.from(
        JSON.stringify({ a: last.updatedAt.toISOString(), i: last.id }),
        "utf8",
      ).toString("base64url");
    } else if (page.length > 0 && last) {
      nextCursor = last.updatedAt;
    }

    return { records: page.map((r) => ({ ...r })), nextCursor, nextPageToken };
  }

  async createItem(input: CreateItemInput): Promise<Item> {
    for (const existing of this.items.values()) {
      if (existing.merchantId === input.merchantId && existing.code === input.code) {
        throw new ItemCodeConflictError(input.code);
      }
    }
    const row: Item = {
      id: input.id,
      merchantId: input.merchantId,
      code: input.code,
      name: input.name,
      priceIdr: input.priceIdr,
      uomId: input.uomId,
      bomId: input.bomId ?? null,
      isStockTracked: input.isStockTracked ?? true,
      isActive: input.isActive ?? true,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.items.set(row.id, row);
    return { ...row };
  }

  async updateItem(input: UpdateItemInput): Promise<Item | null> {
    const current = this.items.get(input.id);
    if (!current || current.merchantId !== input.merchantId) return null;
    if (input.patch.code !== undefined && input.patch.code !== current.code) {
      for (const existing of this.items.values()) {
        if (
          existing.id !== current.id &&
          existing.merchantId === current.merchantId &&
          existing.code === input.patch.code
        ) {
          throw new ItemCodeConflictError(input.patch.code);
        }
      }
    }
    const next: Item = {
      ...current,
      ...(input.patch.code !== undefined ? { code: input.patch.code } : {}),
      ...(input.patch.name !== undefined ? { name: input.patch.name } : {}),
      ...(input.patch.priceIdr !== undefined ? { priceIdr: input.patch.priceIdr } : {}),
      ...(input.patch.uomId !== undefined ? { uomId: input.patch.uomId } : {}),
      ...(input.patch.bomId !== undefined ? { bomId: input.patch.bomId } : {}),
      ...(input.patch.isStockTracked !== undefined
        ? { isStockTracked: input.patch.isStockTracked }
        : {}),
      ...(input.patch.isActive !== undefined ? { isActive: input.patch.isActive } : {}),
      updatedAt: input.now,
    };
    this.items.set(next.id, next);
    return { ...next };
  }

  async softDeleteItem(input: { id: string; merchantId: string; now: Date }): Promise<Item | null> {
    const current = this.items.get(input.id);
    if (!current || current.merchantId !== input.merchantId) return null;
    const next: Item = { ...current, isActive: false, updatedAt: input.now };
    this.items.set(next.id, next);
    return { ...next };
  }
}
