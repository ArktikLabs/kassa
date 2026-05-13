import { and, asc, eq, getTableColumns, gt, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { boms } from "../../db/schema/boms.js";
import type { Item, ItemAvailability } from "../../db/schema/items.js";
import { items } from "../../db/schema/items.js";
import { uoms } from "../../db/schema/uoms.js";
import {
  ItemCodeConflictError,
  ItemForeignKeyError,
  type ItemForeignKeyTarget,
} from "./service.js";
import type {
  CreateItemInput,
  ItemsRepository,
  ListItemsInput,
  ListItemsResult,
  UpdateItemInput,
} from "./repository.js";

/**
 * Postgres `SQLSTATE` for `unique_violation`. `pg` surfaces the wire code on
 * `err.code`, not a typed property. Since drizzle-orm 0.39 the pg session
 * rethrows driver errors wrapped in `DrizzleQueryError` with the original
 * `pg` error attached as `cause`, so we walk the cause chain (KASA-133).
 */
const UNIQUE_VIOLATION = "23505";

/**
 * Postgres `SQLSTATE` for `foreign_key_violation`. Fires on `INSERT`/`UPDATE`
 * when the referenced row was deleted between the service's pre-check and
 * the write — the TOCTOU window the service tries to close (KASA-114).
 *
 * `items.bom_id` has no FK in v0 (declared without `.references()` to break the
 * circular import with `boms.ts`), so the bom translation is forward-looking;
 * once the FK lands, the existing constraint name will already be mapped.
 */
const FOREIGN_KEY_VIOLATION = "23503";

const ITEMS_FK_TARGETS: Readonly<Record<string, ItemForeignKeyTarget>> = {
  items_uom_id_uoms_id_fk: "uom_not_found",
  items_bom_id_boms_id_fk: "bom_not_found",
};

/**
 * Walks `err` and any nested `cause` to find the first object exposing a `pg`
 * SQLSTATE on `.code` (a 5-character string). Returns the matched layer so the
 * caller can also read `.constraint` from the same object.
 *
 * Handles both raw pg errors and `DrizzleQueryError`-wrapped errors.
 */
function findPgError(err: unknown): { code: string; constraint?: string } | null {
  const seen = new Set<unknown>();
  let cursor: unknown = err;
  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    if (typeof cursor === "object") {
      const layer = cursor as { code?: unknown; constraint?: unknown; cause?: unknown };
      if (typeof layer.code === "string" && layer.code.length === 5) {
        return typeof layer.constraint === "string"
          ? { code: layer.code, constraint: layer.constraint }
          : { code: layer.code };
      }
      cursor = layer.cause;
      continue;
    }
    break;
  }
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  return findPgError(err)?.code === UNIQUE_VIOLATION;
}

function itemsForeignKeyTarget(err: unknown): ItemForeignKeyTarget | null {
  const pgErr = findPgError(err);
  if (!pgErr || pgErr.code !== FOREIGN_KEY_VIOLATION || !pgErr.constraint) return null;
  return ITEMS_FK_TARGETS[pgErr.constraint] ?? null;
}

/**
 * Drizzle-backed `ItemsRepository` against Postgres. Queries use the
 * `items_merchant_updated_at_idx` and `items_merchant_code_uniq` indexes
 * (KASA-21). `list` paginates `(updated_at ASC, id ASC)` so cursor boundaries
 * are deterministic even when two rows share an `updated_at`.
 *
 * Cursor stamp is sourced from `to_jsonb(updated_at)#>>'{}'` (full-microsecond
 * ISO 8601) rather than the JS `Date`, so the boundary survives the
 * Postgres/JS precision gap; see outlets `pg-repository.ts` for the rationale.
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

    const selectShape = {
      ...getTableColumns(items),
      updatedAtIso: sql<string>`to_jsonb(${items.updatedAt})#>>'{}'`.as("updated_at_iso"),
    };

    let rows: (Item & { updatedAtIso: string })[];
    if (input.cursor) {
      // (updated_at, id) > (cursor.updated_at, cursor.id) with the cursor
      // stamp passed verbatim into ::timestamptz to preserve microseconds.
      rows = await this.db
        .select(selectShape)
        .from(items)
        .where(
          and(
            eq(items.merchantId, merchantId),
            sql`(${items.updatedAt}, ${items.id}) > (${input.cursor.updatedAt}::timestamptz, ${input.cursor.id}::uuid)`,
          ),
        )
        .orderBy(asc(items.updatedAt), asc(items.id))
        .limit(scanLimit);
    } else if (input.updatedAfter) {
      rows = await this.db
        .select(selectShape)
        .from(items)
        .where(and(eq(items.merchantId, merchantId), gt(items.updatedAt, input.updatedAfter)))
        .orderBy(asc(items.updatedAt), asc(items.id))
        .limit(scanLimit);
    } else {
      rows = await this.db
        .select(selectShape)
        .from(items)
        .where(eq(items.merchantId, merchantId))
        .orderBy(asc(items.updatedAt), asc(items.id))
        .limit(scanLimit);
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1) ?? null;

    const nextBoundary = last ? { updatedAtIso: last.updatedAtIso, id: last.id } : null;
    const records: Item[] = page.map(({ updatedAtIso: _drop, ...row }) => row);
    return { records, nextBoundary, hasMore };
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
          ...(input.taxRate !== undefined ? { taxRate: input.taxRate } : {}),
          ...(input.availability !== undefined ? { availability: input.availability } : {}),
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
      const fkTarget = itemsForeignKeyTarget(err);
      if (fkTarget) {
        const id = fkTarget === "uom_not_found" ? input.uomId : (input.bomId ?? "");
        throw new ItemForeignKeyError(fkTarget, id);
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
      taxRate: number;
      availability: ItemAvailability;
      isActive: boolean;
      updatedAt: Date;
    }> = { updatedAt: input.now };
    if (input.patch.code !== undefined) patch.code = input.patch.code;
    if (input.patch.name !== undefined) patch.name = input.patch.name;
    if (input.patch.priceIdr !== undefined) patch.priceIdr = input.patch.priceIdr;
    if (input.patch.uomId !== undefined) patch.uomId = input.patch.uomId;
    if (input.patch.bomId !== undefined) patch.bomId = input.patch.bomId;
    if (input.patch.isStockTracked !== undefined) patch.isStockTracked = input.patch.isStockTracked;
    if (input.patch.taxRate !== undefined) patch.taxRate = input.patch.taxRate;
    if (input.patch.availability !== undefined) patch.availability = input.patch.availability;
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
      const fkTarget = itemsForeignKeyTarget(err);
      if (fkTarget) {
        const id =
          fkTarget === "uom_not_found" ? (input.patch.uomId ?? "") : (input.patch.bomId ?? "");
        throw new ItemForeignKeyError(fkTarget, id);
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
