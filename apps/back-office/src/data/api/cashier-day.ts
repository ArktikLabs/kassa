/*
 * Cashier-day report API client (KASA-368).
 *
 * Wraps `GET /v1/reports/cashier-day` and the matching `…/export.csv`
 * download. Mirrors the dashboard client's error envelope so the page can
 * surface the same "ask DevOps to wire the deploy" UX without a private
 * error type. Cookies ride along (`credentials: "include"`) for the staff
 * session.
 *
 * CSV downloads do not go through this module — the page triggers them as
 * a same-origin GET via `<a href>` so the browser's download flow handles
 * the file save. The page builds the URL via `cashierDayCsvUrl`.
 */

import { type CashierDayResponse, cashierDayResponse } from "@kassa/schemas/reports";
import { apiBaseUrl, isApiBaseUrlConfigured } from "./config";

export type CashierDayErrorCode =
  | "unauthorized"
  | "forbidden"
  | "validation_error"
  | "not_configured"
  | "network_error"
  | "unknown";

export class CashierDayFetchError extends Error {
  readonly code: CashierDayErrorCode;
  readonly status: number | null;

  constructor(code: CashierDayErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "CashierDayFetchError";
    this.code = code;
    this.status = status;
  }
}

export interface FetchCashierDayInput {
  outletId: string;
  businessDate: string;
}

export async function fetchCashierDayReport(
  input: FetchCashierDayInput,
  { signal, fetchImpl }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<CashierDayResponse> {
  if (!isApiBaseUrlConfigured()) {
    throw new CashierDayFetchError(
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
    response = await doFetch(`${apiBaseUrl()}/v1/reports/cashier-day?${params.toString()}`, init);
  } catch (err) {
    throw new CashierDayFetchError(
      "network_error",
      err instanceof Error ? err.message : "network error",
    );
  }

  if (response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new CashierDayFetchError(
        "unknown",
        err instanceof Error ? err.message : "invalid response body",
        response.status,
      );
    }
    const parsed = cashierDayResponse.safeParse(body);
    if (!parsed.success) {
      throw new CashierDayFetchError(
        "unknown",
        "Cashier-day response did not match the expected contract.",
        response.status,
      );
    }
    return parsed.data;
  }

  let code: CashierDayErrorCode = "unknown";
  let message = `cashier-day fetch failed (HTTP ${response.status})`;
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

  throw new CashierDayFetchError(code, message, response.status);
}

/**
 * Build the same-origin URL the page hands to a `<a download>` link so the
 * browser triggers a file save against `/v1/reports/cashier-day/export.csv`.
 * Returns `null` when the API base URL is not configured so the page can
 * disable the link rather than render a broken anchor.
 */
export function cashierDayCsvUrl(input: FetchCashierDayInput): string | null {
  if (!isApiBaseUrlConfigured()) return null;
  const params = new URLSearchParams();
  params.set("outletId", input.outletId);
  params.set("businessDate", input.businessDate);
  return `${apiBaseUrl()}/v1/reports/cashier-day/export.csv?${params.toString()}`;
}
