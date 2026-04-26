import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { type Uom, uoms } from "../../db/schema/uoms.js";
import { decodePageToken, encodePageToken } from "../../lib/page-token.js";
import type { ListUomsInput, ListUomsResult, UomsRepository } from "./uoms-repository.js";

/**
 * Drizzle-backed `UomsRepository`. Hits `uoms_merchant_updated_at_idx`;
 * cursor stable on `(updated_at ASC, id ASC)`.
 */
export class PgUomsRepository implements UomsRepository {
  constructor(private readonly db: Database) {}

  async listUoms(input: ListUomsInput): Promise<ListUomsResult> {
    const { merchantId, limit } = input;
    const scanLimit = limit + 1;

    let rows: Uom[];
    if (input.pageToken) {
      const boundary = decodePageToken(input.pageToken);
      const boundaryAt = new Date(boundary.a);
      rows = await this.db
        .select()
        .from(uoms)
        .where(
          and(
            eq(uoms.merchantId, merchantId),
            sql`(${uoms.updatedAt}, ${uoms.id}) > (${boundaryAt.toISOString()}::timestamptz, ${boundary.i}::uuid)`,
          ),
        )
        .orderBy(asc(uoms.updatedAt), asc(uoms.id))
        .limit(scanLimit);
    } else if (input.updatedAfter) {
      rows = await this.db
        .select()
        .from(uoms)
        .where(and(eq(uoms.merchantId, merchantId), gt(uoms.updatedAt, input.updatedAfter)))
        .orderBy(asc(uoms.updatedAt), asc(uoms.id))
        .limit(scanLimit);
    } else {
      rows = await this.db
        .select()
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
      nextPageToken = encodePageToken({ a: last.updatedAt.toISOString(), i: last.id });
    } else if (last) {
      nextCursor = last.updatedAt;
    }

    return { records: page, nextCursor, nextPageToken };
  }
}
