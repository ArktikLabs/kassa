import { and, asc, eq, getTableColumns, gt, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { type Outlet, outlets } from "../../db/schema/outlets.js";
import { decodePageToken, encodePageToken } from "../../lib/page-token.js";
import type { ListOutletsInput, ListOutletsResult, OutletsRepository } from "./repository.js";

/**
 * Drizzle-backed `OutletsRepository`. List queries hit the
 * `outlets_merchant_updated_at_idx` index (KASA-21) and paginate
 * `(updated_at ASC, id ASC)` so cursor boundaries are deterministic when
 * two rows share an `updated_at`.
 *
 * The cursor stamp is read via `to_jsonb(updated_at)#>>'{}'` (full-microsecond
 * ISO 8601 with explicit offset) instead of `updated_at.toISOString()`. JS
 * `Date` is millisecond-precision, but `timestamptz` stores microseconds, so a
 * Date-roundtripped cursor would be strictly less than the stored value and
 * the boundary row would re-appear on the next page. Passing the projected
 * string verbatim through `::timestamptz` is lossless.
 */
export class PgOutletsRepository implements OutletsRepository {
  constructor(private readonly db: Database) {}

  async findById(input: { merchantId: string; outletId: string }): Promise<Outlet | null> {
    const rows = await this.db
      .select()
      .from(outlets)
      .where(and(eq(outlets.id, input.outletId), eq(outlets.merchantId, input.merchantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listOutlets(input: ListOutletsInput): Promise<ListOutletsResult> {
    const { merchantId, limit } = input;
    const scanLimit = limit + 1;

    const selectShape = {
      ...getTableColumns(outlets),
      updatedAtIso: sql<string>`to_jsonb(${outlets.updatedAt})#>>'{}'`.as("updated_at_iso"),
    };

    let rows: (Outlet & { updatedAtIso: string })[];
    if (input.pageToken) {
      const boundary = decodePageToken(input.pageToken);
      rows = await this.db
        .select(selectShape)
        .from(outlets)
        .where(
          and(
            eq(outlets.merchantId, merchantId),
            sql`(${outlets.updatedAt}, ${outlets.id}) > (${boundary.a}::timestamptz, ${boundary.i}::uuid)`,
          ),
        )
        .orderBy(asc(outlets.updatedAt), asc(outlets.id))
        .limit(scanLimit);
    } else if (input.updatedAfter) {
      rows = await this.db
        .select(selectShape)
        .from(outlets)
        .where(and(eq(outlets.merchantId, merchantId), gt(outlets.updatedAt, input.updatedAfter)))
        .orderBy(asc(outlets.updatedAt), asc(outlets.id))
        .limit(scanLimit);
    } else {
      rows = await this.db
        .select(selectShape)
        .from(outlets)
        .where(eq(outlets.merchantId, merchantId))
        .orderBy(asc(outlets.updatedAt), asc(outlets.id))
        .limit(scanLimit);
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1) ?? null;

    let nextCursor: Date | null = null;
    let nextPageToken: string | null = null;

    if (hasMore && last) {
      nextPageToken = encodePageToken({ a: last.updatedAtIso, i: last.id });
    } else if (last) {
      nextCursor = last.updatedAt;
    }

    const records: Outlet[] = page.map(({ updatedAtIso: _drop, ...row }) => row);
    return { records, nextCursor, nextPageToken };
  }
}
