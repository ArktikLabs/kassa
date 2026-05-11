/*
 * Dashboard API client (KASA-237).
 *
 * Wraps `GET /v1/reports/dashboard`. The session cookie is HTTP-only and
 * cross-origin in production, so every request sends `credentials: "include"`
 * — same posture as the session login client.
 *
 * Errors mirror the API's `{ error: { code, message } }` envelope:
 *
 *   - `not_configured` — `VITE_API_BASE_URL` is unset; render the same
 *     "ask DevOps to wire the deploy" UX as the login screen.
 *   - `unauthorized` — staff session missing or expired; route guard pushes
 *     the user back to /login.
 *   - `forbidden` — role gate (manager/owner only).
 *   - `network_error` — fetch rejected (offline / DNS / CORS preflight).
 *   - `unknown` — anything else, including a malformed response body.
 */

import { type DashboardSummaryResponse, dashboardSummaryResponse } from "@kassa/schemas/dashboard";
import { apiBaseUrl, isApiBaseUrlConfigured } from "./config";

export type DashboardErrorCode =
  | "unauthorized"
  | "forbidden"
  | "validation_error"
  | "not_configured"
  | "network_error"
  | "unknown";

export class DashboardFetchError extends Error {
  readonly code: DashboardErrorCode;
  readonly status: number | null;

  constructor(code: DashboardErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "DashboardFetchError";
    this.code = code;
    this.status = status;
  }
}

export interface FetchDashboardSummaryInput {
  outletId: string | null;
  from: string;
  to: string;
}

export async function fetchDashboardSummary(
  input: FetchDashboardSummaryInput,
  { signal, fetchImpl }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<DashboardSummaryResponse> {
  if (!isApiBaseUrlConfigured()) {
    throw new DashboardFetchError(
      "not_configured",
      "VITE_API_BASE_URL is not set; the back-office cannot reach the Kassa API.",
    );
  }
  const params = new URLSearchParams();
  if (input.outletId) params.set("outletId", input.outletId);
  params.set("from", input.from);
  params.set("to", input.to);

  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    const init: RequestInit = { method: "GET", credentials: "include" };
    if (signal) init.signal = signal;
    response = await doFetch(`${apiBaseUrl()}/v1/reports/dashboard?${params.toString()}`, init);
  } catch (err) {
    throw new DashboardFetchError(
      "network_error",
      err instanceof Error ? err.message : "network error",
    );
  }

  if (response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new DashboardFetchError(
        "unknown",
        err instanceof Error ? err.message : "invalid response body",
        response.status,
      );
    }
    const parsed = dashboardSummaryResponse.safeParse(body);
    if (!parsed.success) {
      throw new DashboardFetchError(
        "unknown",
        "Dashboard response did not match the expected contract.",
        response.status,
      );
    }
    return parsed.data;
  }

  let code: DashboardErrorCode = "unknown";
  let message = `dashboard fetch failed (HTTP ${response.status})`;
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

  throw new DashboardFetchError(code, message, response.status);
}
