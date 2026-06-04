/*
 * Period summary API client (KASA-327).
 *
 * Wraps `GET /v1/admin/sales/summary`. The session cookie is HTTP-only and
 * cross-origin in production, so every request sends `credentials: "include"`
 * — same posture as the dashboard / login clients.
 *
 * Error codes mirror the API's `{ error: { code, message } }` envelope:
 *
 *   - `range_too_large` — the picked `[from, to]` exceeds the 92-day cap;
 *     surfaced inline so the back-office can prompt the merchant to narrow.
 *   - `not_configured` — `VITE_API_BASE_URL` is unset.
 *   - `unauthorized` / `forbidden` — staff session missing or wrong role.
 *   - `network_error` — fetch rejected.
 *   - `unknown` — anything else, including a malformed response body.
 */

import {
  type SalesSummaryGroupBy,
  type SalesSummaryResponse,
  salesSummaryResponse,
} from "@kassa/schemas/salesSummary";
import { apiBaseUrl, isApiBaseUrlConfigured } from "./config";

export type SalesSummaryErrorCode =
  | "range_too_large"
  | "unauthorized"
  | "forbidden"
  | "validation_error"
  | "not_configured"
  | "network_error"
  | "unknown";

export class SalesSummaryFetchError extends Error {
  readonly code: SalesSummaryErrorCode;
  readonly status: number | null;

  constructor(code: SalesSummaryErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "SalesSummaryFetchError";
    this.code = code;
    this.status = status;
  }
}

export interface FetchSalesSummaryInput {
  outletId: string | null;
  from: string;
  to: string;
  groupBy: SalesSummaryGroupBy;
}

export async function fetchSalesSummary(
  input: FetchSalesSummaryInput,
  { signal, fetchImpl }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<SalesSummaryResponse> {
  if (!isApiBaseUrlConfigured()) {
    throw new SalesSummaryFetchError(
      "not_configured",
      "VITE_API_BASE_URL is not set; the back-office cannot reach the Kassa API.",
    );
  }
  const params = new URLSearchParams();
  if (input.outletId) params.set("outletId", input.outletId);
  params.set("from", input.from);
  params.set("to", input.to);
  params.set("groupBy", input.groupBy);

  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    const init: RequestInit = { method: "GET", credentials: "include" };
    if (signal) init.signal = signal;
    response = await doFetch(`${apiBaseUrl()}/v1/admin/sales/summary?${params.toString()}`, init);
  } catch (err) {
    throw new SalesSummaryFetchError(
      "network_error",
      err instanceof Error ? err.message : "network error",
    );
  }

  if (response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new SalesSummaryFetchError(
        "unknown",
        err instanceof Error ? err.message : "invalid response body",
        response.status,
      );
    }
    const parsed = salesSummaryResponse.safeParse(body);
    if (!parsed.success) {
      throw new SalesSummaryFetchError(
        "unknown",
        "Sales summary response did not match the expected contract.",
        response.status,
      );
    }
    return parsed.data;
  }

  let code: SalesSummaryErrorCode = "unknown";
  let message = `sales summary fetch failed (HTTP ${response.status})`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    const bodyCode = body.error?.code;
    if (
      bodyCode === "range_too_large" ||
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

  throw new SalesSummaryFetchError(code, message, response.status);
}
