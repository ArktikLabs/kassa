import type { Uom } from "../../db/schema/uoms.js";
import { decodePageToken, encodePageToken } from "../../lib/page-token.js";
import type { ListUomsInput, ListUomsResult, UomsRepository } from "./uoms-repository.js";

export interface SeedUomInput {
  id: string;
  merchantId: string;
  code: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export class InMemoryUomsRepository implements UomsRepository {
  private readonly uoms = new Map<string, Uom>();

  seedUom(input: SeedUomInput): void {
    this.uoms.set(input.id, {
      id: input.id,
      merchantId: input.merchantId,
      code: input.code,
      name: input.name,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
  }

  async listUoms(input: ListUomsInput): Promise<ListUomsResult> {
    let tokenBoundary: { updatedAt: Date; id: string } | null = null;
    if (input.pageToken) {
      const decoded = decodePageToken(input.pageToken);
      tokenBoundary = { updatedAt: new Date(decoded.a), id: decoded.i };
    }
    const updatedAfter = input.updatedAfter;

    const filtered = [...this.uoms.values()]
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

    return { records: page.map((r) => ({ ...r })), nextCursor, nextPageToken };
  }
}
