import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { type Outlet, outlets } from "../../db/schema/outlets.js";
import { decodePageToken, encodePageToken } from "../../lib/page-token.js";
import type { ListOutletsInput, ListOutletsResult, OutletsRepository } from "./repository.js";

/**
 * Drizzle-backed `OutletsRepository`. List queries hit the
 * `outlets_merchant_updated_at_idx` index (KASA-21) and paginate
 * `(updated_at ASC, id ASC)` so cursor boundaries are deterministic when
 * two rows share an `updated_at`.
 */
export class PgOutletsRepository implements OutletsRepository {
  constructor(private readonly db: Database) {}

  async listOutlets(input: ListOutletsInput): Promise<ListOutletsResult> {
    const { merchantId, limit } = input;
    const scanLimit = limit + 1;

    let rows: Outlet[];
    if (input.pageToken) {
      const boundary = decodePageToken(input.pageToken);
      const boundaryAt = new Date(boundary.a);
      rows = await this.db
        .select()
        .from(outlets)
        .where(
          and(
            eq(outlets.merchantId, merchantId),
            sql`(${outlets.updatedAt}, ${outlets.id}) > (${boundaryAt.toISOString()}::timestamptz, ${boundary.i}::uuid)`,
          ),
        )
        .orderBy(asc(outlets.updatedAt), asc(outlets.id))
        .limit(scanLimit);
    } else if (input.updatedAfter) {
      rows = await this.db
        .select()
        .from(outlets)
        .where(and(eq(outlets.merchantId, merchantId), gt(outlets.updatedAt, input.updatedAfter)))
        .orderBy(asc(outlets.updatedAt), asc(outlets.id))
        .limit(scanLimit);
    } else {
      rows = await this.db
        .select()
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
      nextPageToken = encodePageToken({ a: last.updatedAt.toISOString(), i: last.id });
    } else if (last) {
      nextCursor = last.updatedAt;
    }

    return { records: page, nextCursor, nextPageToken };
  }
}
