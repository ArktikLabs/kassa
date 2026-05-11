/*
 * Sales-history API client (KASA-249).
 *
 * Wraps `GET /v1/sales?outletId=&businessDate=` — the existing single-day
 * single-outlet read path defined by `@kassa/schemas/sync`'s
 * `saleListQuery` / `saleListResponse`. The back-office sales-history
 * page needs a multi-day, multi-outlet view, so this client fans the
 * request out across `(outletId × businessDate)` and the page merges
 * + filters the results in memory. The server already paginates by
 * (merchant, outlet, day) bucket; the acceptance suite caps the bucket
 * at 50 sales/day/outlet so the fan-out is bounded.
 *
 * Error envelope mirrors the dashboard client (KASA-237) so the page
 * can render the same "ask DevOps to wire the deploy" UX without a
 * private error type.
 */

import { type SaleListResponse, saleListResponse } from "@kassa/schemas";
import { apiBaseUrl, isApiBaseUrlConfigured } from "./config";

export type SalesFetchErrorCode =
  | "unauthorized"
  | "forbidden"
  | "validation_error"
  | "not_configured"
  | "network_error"
  | "unknown";

export class SalesFetchError extends Error {
  readonly code: SalesFetchErrorCode;
  readonly status: number | null;

  constructor(code: SalesFetchErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "SalesFetchError";
    this.code = code;
    this.status = status;
  }
}

export interface FetchSalesBucketInput {
  outletId: string;
  businessDate: string;
}

export async function fetchSalesBucket(
  input: FetchSalesBucketInput,
  { signal, fetchImpl }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<SaleListResponse> {
  if (!isApiBaseUrlConfigured()) {
    throw new SalesFetchError(
      "not_configured",
      "VITE_API_BASE_URL is not set; the back-office cannot reach the Kassa API.",
    );
  }
  const params = new URLSearchParams();
  params.set("outletId", input.outletId);
  params.set("businessDate", input.businessDate);

  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    const init: RequestInit = { method: "GET", credentials: "include" };
    if (signal) init.signal = signal;
    response = await doFetch(`${apiBaseUrl()}/v1/sales?${params.toString()}`, init);
  } catch (err) {
    throw new SalesFetchError(
      "network_error",
      err instanceof Error ? err.message : "network error",
    );
  }

  if (response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new SalesFetchError(
        "unknown",
        err instanceof Error ? err.message : "invalid response body",
        response.status,
      );
    }
    const parsed = saleListResponse.safeParse(body);
    if (!parsed.success) {
      throw new SalesFetchError(
        "unknown",
        "Sales list response did not match the expected contract.",
        response.status,
      );
    }
    return parsed.data;
  }

  let code: SalesFetchErrorCode = "unknown";
  let message = `sales fetch failed (HTTP ${response.status})`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    const bodyCode = body.error?.code;
    if (
      bodyCode === "unauthorized" ||
      bodyCode === "forbidden" ||
      bodyCode === "validation_error"
    ) {
      code = bodyCode;
    } else if (response.status === 401) {
      code = "unauthorized";
    } else if (response.status === 403) {
      code = "forbidden";
    }
    if (typeof body.error?.message === "string" && body.error.message.length > 0) {
      message = body.error.message;
    }
  } catch {
    if (response.status === 401) code = "unauthorized";
    else if (response.status === 403) code = "forbidden";
  }

  throw new SalesFetchError(code, message, response.status);
}

export interface FetchSalesHistoryInput {
  /** Outlets to scope the fetch to. Pass merchant-wide list for "all outlets". */
  outletIds: readonly string[];
  /** Inclusive lower bound, YYYY-MM-DD (Asia/Jakarta business day). */
  from: string;
  /** Inclusive upper bound, YYYY-MM-DD. */
  to: string;
}

export interface FetchSalesHistoryOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Fan-out fetch across `(outletId × businessDate)` buckets in the
 * window, then concat the records in `createdAt` descending order. The
 * caller (the page) applies tender / cashier filtering and paginates
 * via the shared `DataTable` primitive.
 */
export async function fetchSalesHistory(
  input: FetchSalesHistoryInput,
  options: FetchSalesHistoryOptions = {},
): Promise<SaleListResponse> {
  const dates = enumerateBusinessDays(input.from, input.to);
  if (dates.length === 0 || input.outletIds.length === 0) {
    return { records: [] };
  }
  const buckets: FetchSalesBucketInput[] = [];
  for (const outletId of input.outletIds) {
    for (const businessDate of dates) {
      buckets.push({ outletId, businessDate });
    }
  }
  const pages = await Promise.all(
    buckets.map((b) => fetchSalesBucket(b, options)),
  );
  const records = pages.flatMap((p) => p.records);
  records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { records };
}

/**
 * Walk `from..to` inclusive as YYYY-MM-DD strings. Dates are treated as
 * Asia/Jakarta business days; arithmetic uses midnight UTC and slices
 * the leading date component, so any fixed-offset zone yields the
 * same chain. Returns empty for an inverted range.
 */
export function enumerateBusinessDays(from: string, to: string): string[] {
  if (!isValidBusinessDate(from) || !isValidBusinessDate(to)) return [];
  if (from > to) return [];
  const out: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    out.push(cursor);
    const parsed = Date.parse(`${cursor}T00:00:00.000Z`);
    if (Number.isNaN(parsed)) break;
    const next = new Date(parsed + 86_400_000);
    cursor = next.toISOString().slice(0, 10);
  }
  return out;
}

function isValidBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(t);
}
