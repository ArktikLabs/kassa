import type { Outlet } from "../../db/schema/outlets.js";
import { decodePageToken, encodePageToken } from "../../lib/page-token.js";
import type { ListOutletsInput, ListOutletsResult, OutletsRepository } from "./repository.js";

export interface SeedOutletInput {
  id: string;
  merchantId: string;
  code: string;
  name: string;
  timezone?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory `OutletsRepository` for tests + bootstrap. Mirrors the Pg
 * impl's `(updatedAt ASC, id ASC)` ordering so cursor boundaries are
 * deterministic across both backings.
 */
export class InMemoryOutletsRepository implements OutletsRepository {
  private readonly outlets = new Map<string, Outlet>();

  seedOutlet(input: SeedOutletInput): void {
    const row: Outlet = {
      id: input.id,
      merchantId: input.merchantId,
      code: input.code,
      name: input.name,
      timezone: input.timezone ?? "Asia/Jakarta",
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
    this.outlets.set(row.id, row);
  }

  async findById(input: { merchantId: string; outletId: string }): Promise<Outlet | null> {
    const row = this.outlets.get(input.outletId);
    if (!row || row.merchantId !== input.merchantId) return null;
    return { ...row };
  }

  async listOutlets(input: ListOutletsInput): Promise<ListOutletsResult> {
    let tokenBoundary: { updatedAt: Date; id: string } | null = null;
    if (input.pageToken) {
      const decoded = decodePageToken(input.pageToken);
      tokenBoundary = { updatedAt: new Date(decoded.a), id: decoded.i };
    }
    const updatedAfter = input.updatedAfter;

    const filtered = [...this.outlets.values()]
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
