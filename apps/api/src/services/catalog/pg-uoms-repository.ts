import { and, asc, eq, getTableColumns, gt, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { type Uom, uoms } from "../../db/schema/uoms.js";
import { decodePageToken, encodePageToken } from "../../lib/page-token.js";
import type { ListUomsInput, ListUomsResult, UomsRepository } from "./uoms-repository.js";

/**
 * Drizzle-backed `UomsRepository`. Hits `uoms_merchant_updated_at_idx`;
 * cursor stable on `(updated_at ASC, id ASC)`.
 *
 * Cursor stamp uses the full-microsecond `to_jsonb(updated_at)#>>'{}'`
 * projection so Postgres timestamp precision survives the round-trip; see
 * `pg-repository.ts` (outlets) for the rationale.
 */
export class PgUomsRepository implements UomsRepository {
  constructor(private readonly db: Database) {}

  async listUoms(input: ListUomsInput): Promise<ListUomsResult> {
    const { merchantId, limit } = input;
    const scanLimit = limit + 1;

    const selectShape = {
      ...getTableColumns(uoms),
      updatedAtIso: sql<string>`to_jsonb(${uoms.updatedAt})#>>'{}'`.as("updated_at_iso"),
    };

    let rows: (Uom & { updatedAtIso: string })[];
    if (input.pageToken) {
      const boundary = decodePageToken(input.pageToken);
      rows = await this.db
        .select(selectShape)
        .from(uoms)
        .where(
          and(
            eq(uoms.merchantId, merchantId),
            sql`(${uoms.updatedAt}, ${uoms.id}) > (${boundary.a}::timestamptz, ${boundary.i}::uuid)`,
          ),
        )
        .orderBy(asc(uoms.updatedAt), asc(uoms.id))
        .limit(scanLimit);
    } else if (input.updatedAfter) {
      rows = await this.db
        .select(selectShape)
        .from(uoms)
        .where(and(eq(uoms.merchantId, merchantId), gt(uoms.updatedAt, input.updatedAfter)))
        .orderBy(asc(uoms.updatedAt), asc(uoms.id))
        .limit(scanLimit);
    } else {
      rows = await this.db
        .select(selectShape)
        .from(uoms)
        .where(eq(uoms.merchantId, merchantId))
        .orderBy(asc(uoms.updatedAt), asc(uoms.id))
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

    const records: Uom[] = page.map(({ updatedAtIso: _drop, ...row }) => row);
    return { records, nextCursor, nextPageToken };
  }
}
