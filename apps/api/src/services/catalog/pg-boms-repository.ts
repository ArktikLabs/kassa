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

    let headers: BomHeaderRow[];
    if (input.pageToken) {
      const boundary = decodePageToken(input.pageToken);
      const boundaryAt = new Date(boundary.a);
      headers = await this.db
        .select({
          id: boms.id,
          merchantId: boms.merchantId,
          itemId: boms.itemId,
          updatedAt: boms.updatedAt,
        })
        .from(boms)
        .where(
          and(
            eq(boms.merchantId, merchantId),
            sql`(${boms.updatedAt}, ${boms.id}) > (${boundaryAt.toISOString()}::timestamptz, ${boundary.i}::uuid)`,
          ),
        )
        .orderBy(asc(boms.updatedAt), asc(boms.id))
        .limit(scanLimit);
    } else if (input.updatedAfter) {
      headers = await this.db
        .select({
          id: boms.id,
          merchantId: boms.merchantId,
          itemId: boms.itemId,
          updatedAt: boms.updatedAt,
        })
        .from(boms)
        .where(and(eq(boms.merchantId, merchantId), gt(boms.updatedAt, input.updatedAfter)))
        .orderBy(asc(boms.updatedAt), asc(boms.id))
        .limit(scanLimit);
    } else {
      headers = await this.db
        .select({
          id: boms.id,
          merchantId: boms.merchantId,
          itemId: boms.itemId,
          updatedAt: boms.updatedAt,
        })
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

    const last = records.at(-1) ?? null;
    let nextCursor: Date | null = null;
    let nextPageToken: string | null = null;

    if (hasMore && last) {
      nextPageToken = encodePageToken({ a: last.updatedAt.toISOString(), i: last.id });
    } else if (last) {
      nextCursor = last.updatedAt;
    }

    return { records, nextCursor, nextPageToken };
  }
}
