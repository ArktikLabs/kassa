import { InvalidPageTokenError, decodePageToken } from "../../lib/page-token.js";
import type { BomRow, BomsRepository, ListBomsResult } from "./boms-repository.js";

export const DEFAULT_BOM_PAGE_LIMIT = 100;
export const MAX_BOM_PAGE_LIMIT = 500;

export type BomErrorCode = "invalid_page_token";

export class BomError extends Error {
  constructor(
    readonly code: BomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BomError";
  }
}

export interface BomsServiceDeps {
  repository: BomsRepository;
}

export interface ListBomsCommand {
  merchantId: string;
  updatedAfter?: Date | undefined;
  pageToken?: string | undefined;
  limit?: number | undefined;
}

export class BomsService {
  private readonly repository: BomsRepository;

  constructor(deps: BomsServiceDeps) {
    this.repository = deps.repository;
  }

  async list(cmd: ListBomsCommand): Promise<ListBomsResult> {
    const rawLimit = cmd.limit ?? DEFAULT_BOM_PAGE_LIMIT;
    const limit = Math.max(1, Math.min(MAX_BOM_PAGE_LIMIT, rawLimit));

    let updatedAfter: Date | undefined;
    let pageToken: string | null = null;
    if (cmd.pageToken) {
      try {
        const payload = decodePageToken(cmd.pageToken);
        updatedAfter = new Date(payload.a);
        pageToken = cmd.pageToken;
      } catch (err) {
        if (err instanceof InvalidPageTokenError) {
          throw new BomError("invalid_page_token", err.message);
        }
        throw err;
      }
    } else if (cmd.updatedAfter) {
      updatedAfter = cmd.updatedAfter;
    }

    return this.repository.listBoms({
      merchantId: cmd.merchantId,
      ...(updatedAfter !== undefined ? { updatedAfter } : {}),
      pageToken,
      limit,
    });
  }
}

export function toBomResponse(row: BomRow): {
  id: string;
  itemId: string;
  components: { componentItemId: string; quantity: number; uomId: string }[];
  updatedAt: string;
} {
  return {
    id: row.id,
    itemId: row.itemId,
    components: row.components.map((c) => ({
      componentItemId: c.componentItemId,
      quantity: c.quantity,
      uomId: c.uomId,
    })),
    updatedAt: row.updatedAt.toISOString(),
  };
}
