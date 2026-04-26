import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { bomComponents, boms } from "../../db/schema/boms.js";
import { decodePageToken, encodePageToken } from "../../lib/page-token.js";
import type {
  BomComponentRow,
  BomRow,
  BomsRepository,
  ListBomsInput,
  ListBomsResult,
} from "./boms-repository.js";

interface BomHeaderRow {
  id: string;
  merchantId: string;
  itemId: string;
  updatedAt: Date;
  /** Full-microsecond ISO 8601 stamp from `to_jsonb(updated_at)#>>'{}'`,
   *  used verbatim in the page-token cursor so DB timestamp precision is
   *  preserved across the round-trip (see outlets `pg-repository.ts`). */
  updatedAtIso: string;
}

/**
 * Drizzle-backed `BomsRepository`. The pull is a two-query roundtrip: paginate
 * BOM headers off `boms_merchant_updated_at_idx` (deterministic order
 * `(updated_at ASC, id ASC)`) then fetch component rows with `WHERE bom_id IN
 * (...)`. Two queries beat a single join + dedup at the application layer
 * given typical small component counts (≤10), and lets the page-size budget
 * count headers, not header×component fan-out.
 */
export class PgBomsRepository implements BomsRepository {
  constructor(private readonly db: Database) {}

  async listBoms(input: ListBomsInput): Promise<ListBomsResult> {
    const { merchantId, limit } = input;
    const scanLimit = limit + 1;

    const headerSelect = {
      id: boms.id,
      merchantId: boms.merchantId,
      itemId: boms.itemId,
      updatedAt: boms.updatedAt,
      updatedAtIso: sql<string>`to_jsonb(${boms.updatedAt})#>>'{}'`.as("updated_at_iso"),
    };

    let headers: BomHeaderRow[];
    if (input.pageToken) {
      const boundary = decodePageToken(input.pageToken);
      headers = await this.db
        .select(headerSelect)
        .from(boms)
        .where(
          and(
            eq(boms.merchantId, merchantId),
            sql`(${boms.updatedAt}, ${boms.id}) > (${boundary.a}::timestamptz, ${boundary.i}::uuid)`,
          ),
        )
        .orderBy(asc(boms.updatedAt), asc(boms.id))
        .limit(scanLimit);
    } else if (input.updatedAfter) {
      headers = await this.db
        .select(headerSelect)
        .from(boms)
        .where(and(eq(boms.merchantId, merchantId), gt(boms.updatedAt, input.updatedAfter)))
        .orderBy(asc(boms.updatedAt), asc(boms.id))
        .limit(scanLimit);
    } else {
      headers = await this.db
        .select(headerSelect)
        .from(boms)
        .where(eq(boms.merchantId, merchantId))
        .orderBy(asc(boms.updatedAt), asc(boms.id))
        .limit(scanLimit);
    }

    const hasMore = headers.length > limit;
    const page = hasMore ? headers.slice(0, limit) : headers;
    const ids = page.map((h) => h.id);

    const componentRows = ids.length
      ? await this.db
          .select({
            bomId: bomComponents.bomId,
            componentItemId: bomComponents.componentItemId,
            quantity: bomComponents.quantity,
            uomId: bomComponents.uomId,
          })
          .from(bomComponents)
          .where(inArray(bomComponents.bomId, ids))
      : [];

    const componentsByBom = new Map<string, BomComponentRow[]>();
    for (const row of componentRows) {
      // Drizzle returns numeric(18,6) as a string; the wire schema is a number.
      const qty = typeof row.quantity === "string" ? Number(row.quantity) : row.quantity;
      const list = componentsByBom.get(row.bomId);
      const component: BomComponentRow = {
        componentItemId: row.componentItemId,
        quantity: qty,
        uomId: row.uomId,
      };
      if (list) {
        list.push(component);
      } else {
        componentsByBom.set(row.bomId, [component]);
      }
    }

    const records: BomRow[] = page.map((h) => ({
      id: h.id,
      merchantId: h.merchantId,
      itemId: h.itemId,
      components: (componentsByBom.get(h.id) ?? []).sort((a, b) =>
        a.componentItemId < b.componentItemId ? -1 : a.componentItemId > b.componentItemId ? 1 : 0,
      ),
      updatedAt: h.updatedAt,
    }));

    const lastHeader = page.at(-1) ?? null;
    let nextCursor: Date | null = null;
    let nextPageToken: string | null = null;

    if (hasMore && lastHeader) {
      nextPageToken = encodePageToken({ a: lastHeader.updatedAtIso, i: lastHeader.id });
    } else if (lastHeader) {
      nextCursor = lastHeader.updatedAt;
    }

    return { records, nextCursor, nextPageToken };
  }
}
