import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { boms } from "../../db/schema/boms.js";
import type { Item } from "../../db/schema/items.js";
import { items } from "../../db/schema/items.js";
import { uoms } from "../../db/schema/uoms.js";
import { ItemCodeConflictError } from "./service.js";
import type {
  CreateItemInput,
  ItemsRepository,
  ListItemsInput,
  ListItemsResult,
  UpdateItemInput,
} from "./repository.js";

/**
 * Postgres `SQLSTATE` for `unique_violation`. `pg` surfaces the wire code on
 * `err.code`, not a typed property.
 */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

interface PageTokenPayload {
  a: string;
  i: string;
}

function decodePageToken(token: string): PageTokenPayload {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as PageTokenPayload;
}

/**
 * Drizzle-backed `ItemsRepository` against Postgres. Queries use the
 * `items_merchant_updated_at_idx` and `items_merchant_code_uniq` indexes
 * (KASA-21). `list` paginates `(updated_at ASC, id ASC)` so cursor boundaries
 * are deterministic even when two rows share an `updated_at`.
 */
export class PgItemsRepository implements ItemsRepository {
  constructor(private readonly db: Database) {}

  async findItem(input: { id: string; merchantId: string }): Promise<Item | null> {
    const rows = await this.db
      .select()
      .from(items)
      .where(and(eq(items.id, input.id), eq(items.merchantId, input.merchantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listItems(input: ListItemsInput): Promise<ListItemsResult> {
    const { merchantId, limit } = input;
    const scanLimit = limit + 1;

    let rows: Item[];
    if (input.pageToken) {
      const boundary = decodePageToken(input.pageToken);
      const boundaryAt = new Date(boundary.a);
      // (updated_at, id) > (boundaryAt, boundary.i)
      rows = await this.db
        .select()
        .from(items)
        .where(
          and(
            eq(items.merchantId, merchantId),
            sql`(${items.updatedAt}, ${items.id}) > (${boundaryAt.toISOString()}::timestamptz, ${boundary.i}::uuid)`,
          ),
        )
        .orderBy(asc(items.updatedAt), asc(items.id))
        .limit(scanLimit);
    } else if (input.updatedAfter) {
      rows = await this.db
        .select()
        .from(items)
        .where(and(eq(items.merchantId, merchantId), gt(items.updatedAt, input.updatedAfter)))
        .orderBy(asc(items.updatedAt), asc(items.id))
        .limit(scanLimit);
    } else {
      rows = await this.db
        .select()
        .from(items)
        .where(eq(items.merchantId, merchantId))
        .orderBy(asc(items.updatedAt), asc(items.id))
        .limit(scanLimit);
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1) ?? null;

    let nextCursor: Date | null = null;
    let nextPageToken: string | null = null;

    if (hasMore && last) {
      nextPageToken = Buffer.from(
        JSON.stringify({ a: last.updatedAt.toISOString(), i: last.id }),
        "utf8",
      ).toString("base64url");
    } else if (last) {
      nextCursor = last.updatedAt;
    }

    return { records: page, nextCursor, nextPageToken };
  }

  async createItem(input: CreateItemInput): Promise<Item> {
    try {
      const inserted = await this.db
        .insert(items)
        .values({
          id: input.id,
          merchantId: input.merchantId,
          code: input.code,
          name: input.name,
          priceIdr: input.priceIdr,
          uomId: input.uomId,
          bomId: input.bomId ?? null,
          ...(input.isStockTracked !== undefined ? { isStockTracked: input.isStockTracked } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("items.insert returned no row");
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ItemCodeConflictError(input.code);
      }
      throw err;
    }
  }

  async updateItem(input: UpdateItemInput): Promise<Item | null> {
    const patch: Partial<{
      code: string;
      name: string;
      priceIdr: number;
      uomId: string;
      bomId: string | null;
      isStockTracked: boolean;
      isActive: boolean;
      updatedAt: Date;
    }> = { updatedAt: input.now };
    if (input.patch.code !== undefined) patch.code = input.patch.code;
    if (input.patch.name !== undefined) patch.name = input.patch.name;
    if (input.patch.priceIdr !== undefined) patch.priceIdr = input.patch.priceIdr;
    if (input.patch.uomId !== undefined) patch.uomId = input.patch.uomId;
    if (input.patch.bomId !== undefined) patch.bomId = input.patch.bomId;
    if (input.patch.isStockTracked !== undefined) patch.isStockTracked = input.patch.isStockTracked;
    if (input.patch.isActive !== undefined) patch.isActive = input.patch.isActive;

    try {
      const updated = await this.db
        .update(items)
        .set(patch)
        .where(and(eq(items.id, input.id), eq(items.merchantId, input.merchantId)))
        .returning();
      return updated[0] ?? null;
    } catch (err) {
      if (isUniqueViolation(err) && input.patch.code) {
        throw new ItemCodeConflictError(input.patch.code);
      }
      throw err;
    }
  }

  async softDeleteItem(input: { id: string; merchantId: string; now: Date }): Promise<Item | null> {
    const updated = await this.db
      .update(items)
      .set({ isActive: false, updatedAt: input.now })
      .where(and(eq(items.id, input.id), eq(items.merchantId, input.merchantId)))
      .returning();
    return updated[0] ?? null;
  }

  async findUom(input: { id: string; merchantId: string }): Promise<{ id: string } | null> {
    const rows = await this.db
      .select({ id: uoms.id })
      .from(uoms)
      .where(and(eq(uoms.id, input.id), eq(uoms.merchantId, input.merchantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findBom(input: { id: string; merchantId: string }): Promise<{ id: string } | null> {
    const rows = await this.db
      .select({ id: boms.id })
      .from(boms)
      .where(and(eq(boms.id, input.id), eq(boms.merchantId, input.merchantId)))
      .limit(1);
    return rows[0] ?? null;
  }
}
