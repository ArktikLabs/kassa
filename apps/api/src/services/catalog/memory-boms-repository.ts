import { decodePageToken, encodePageToken } from "../../lib/page-token.js";
import type {
  BomComponentRow,
  BomRow,
  BomsRepository,
  ListBomsInput,
  ListBomsResult,
} from "./boms-repository.js";

export interface SeedBomInput {
  id: string;
  merchantId: string;
  itemId: string;
  components: BomComponentRow[];
  updatedAt: Date;
}

/**
 * In-memory `BomsRepository` for tests. Stores headers + components together;
 * the pull shape mirrors the Pg query result after the join.
 */
export class InMemoryBomsRepository implements BomsRepository {
  private readonly boms = new Map<string, BomRow>();

  seedBom(input: SeedBomInput): void {
    this.boms.set(input.id, {
      id: input.id,
      merchantId: input.merchantId,
      itemId: input.itemId,
      components: input.components.map((c) => ({ ...c })),
      updatedAt: input.updatedAt,
    });
  }

  async listBoms(input: ListBomsInput): Promise<ListBomsResult> {
    let tokenBoundary: { updatedAt: Date; id: string } | null = null;
    if (input.pageToken) {
      const decoded = decodePageToken(input.pageToken);
      tokenBoundary = { updatedAt: new Date(decoded.a), id: decoded.i };
    }
    const updatedAfter = input.updatedAfter;

    const filtered = [...this.boms.values()]
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
      nextPageToken = encodePageToken({ a: last.updatedAt.toISOString(), i: last.id });
    } else if (page.length > 0 && last) {
      nextCursor = last.updatedAt;
    }

    return {
      records: page.map((r) => ({ ...r, components: r.components.map((c) => ({ ...c })) })),
      nextCursor,
      nextPageToken,
    };
  }
}
