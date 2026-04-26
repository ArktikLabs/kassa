import type { Uom } from "../../db/schema/uoms.js";
import { InvalidPageTokenError, decodePageToken } from "../../lib/page-token.js";
import type { ListUomsResult, UomsRepository } from "./uoms-repository.js";

export const DEFAULT_UOM_PAGE_LIMIT = 100;
export const MAX_UOM_PAGE_LIMIT = 500;

export type UomErrorCode = "invalid_page_token";

export class UomError extends Error {
  constructor(
    readonly code: UomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UomError";
  }
}

export interface UomsServiceDeps {
  repository: UomsRepository;
}

export interface ListUomsCommand {
  merchantId: string;
  updatedAfter?: Date | undefined;
  pageToken?: string | undefined;
  limit?: number | undefined;
}

export class UomsService {
  private readonly repository: UomsRepository;

  constructor(deps: UomsServiceDeps) {
    this.repository = deps.repository;
  }

  async list(cmd: ListUomsCommand): Promise<ListUomsResult> {
    const rawLimit = cmd.limit ?? DEFAULT_UOM_PAGE_LIMIT;
    const limit = Math.max(1, Math.min(MAX_UOM_PAGE_LIMIT, rawLimit));

    let updatedAfter: Date | undefined;
    let pageToken: string | null = null;
    if (cmd.pageToken) {
      try {
        const payload = decodePageToken(cmd.pageToken);
        updatedAfter = new Date(payload.a);
        pageToken = cmd.pageToken;
      } catch (err) {
        if (err instanceof InvalidPageTokenError) {
          throw new UomError("invalid_page_token", err.message);
        }
        throw err;
      }
    } else if (cmd.updatedAfter) {
      updatedAfter = cmd.updatedAfter;
    }

    return this.repository.listUoms({
      merchantId: cmd.merchantId,
      ...(updatedAfter !== undefined ? { updatedAfter } : {}),
      pageToken,
      limit,
    });
  }
}

export function toUomResponse(row: Uom): {
  id: string;
  code: string;
  name: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    updatedAt: row.updatedAt.toISOString(),
  };
}
