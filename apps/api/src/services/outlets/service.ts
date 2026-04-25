import type { Outlet } from "../../db/schema/outlets.js";
import { InvalidPageTokenError, decodePageToken } from "../../lib/page-token.js";
import type { ListOutletsResult, OutletsRepository } from "./repository.js";

export const DEFAULT_OUTLET_PAGE_LIMIT = 100;
export const MAX_OUTLET_PAGE_LIMIT = 500;

export type OutletErrorCode = "invalid_page_token";

export class OutletError extends Error {
  constructor(
    readonly code: OutletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OutletError";
  }
}

export interface OutletsServiceDeps {
  repository: OutletsRepository;
}

export interface ListOutletsCommand {
  merchantId: string;
  updatedAfter?: Date | undefined;
  pageToken?: string | undefined;
  limit?: number | undefined;
}

export class OutletsService {
  private readonly repository: OutletsRepository;

  constructor(deps: OutletsServiceDeps) {
    this.repository = deps.repository;
  }

  async list(cmd: ListOutletsCommand): Promise<ListOutletsResult> {
    const rawLimit = cmd.limit ?? DEFAULT_OUTLET_PAGE_LIMIT;
    const limit = Math.max(1, Math.min(MAX_OUTLET_PAGE_LIMIT, rawLimit));

    let updatedAfter: Date | undefined;
    let pageToken: string | null = null;
    if (cmd.pageToken) {
      try {
        const payload = decodePageToken(cmd.pageToken);
        updatedAfter = new Date(payload.a);
        pageToken = cmd.pageToken;
      } catch (err) {
        if (err instanceof InvalidPageTokenError) {
          throw new OutletError("invalid_page_token", err.message);
        }
        throw err;
      }
    } else if (cmd.updatedAfter) {
      updatedAfter = cmd.updatedAfter;
    }

    return this.repository.listOutlets({
      merchantId: cmd.merchantId,
      ...(updatedAfter !== undefined ? { updatedAfter } : {}),
      pageToken,
      limit,
    });
  }
}

export function toOutletResponse(row: Outlet): {
  id: string;
  code: string;
  name: string;
  timezone: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    timezone: row.timezone,
    updatedAt: row.updatedAt.toISOString(),
  };
}
