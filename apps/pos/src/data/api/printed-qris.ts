/*
 * Static-QRIS printed-image client (KASA-118 / ADR-008 fallback).
 *
 * Fetches the merchant's printed-QR image for a specific outlet so the clerk
 * can show it to the buyer when the device is offline or when dynamic QRIS
 * fails. The endpoint is expected to return a JSON payload with a base64
 * data URL — keeping the payload textual lets us cache it directly in Dexie
 * without juggling Blob lifetimes across StrictMode renders.
 *
 * Network failures throw a synthetic `network_error` so the panel can fall
 * back to the cached row (ARCHITECTURE.md §3.1 Flow C).
 */
import { apiBaseUrl } from "./config";

export interface PrintedQrisResponse {
  outletId: string;
  /** Data URL ready to drop into `<img src>` — `data:image/png;base64,...`. */
  image: string;
  mimeType: string;
}

export type PrintedQrisErrorCode =
  | "not_found"
  | "unauthorized"
  | "network_error"
  | "upstream_error"
  | "unknown";

export class PrintedQrisApiError extends Error {
  readonly code: PrintedQrisErrorCode;
  readonly status: number | null;

  constructor(code: PrintedQrisErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "PrintedQrisApiError";
    this.code = code;
    this.status = status;
  }
}

interface FetchOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function fetchPrintedQris(
  outletId: string,
  options: FetchOptions = {},
): Promise<PrintedQrisResponse> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    const init: RequestInit = { method: "GET" };
    if (options.signal) init.signal = options.signal;
    response = await doFetch(
      `${apiBaseUrl()}/v1/outlets/${encodeURIComponent(outletId)}/printed-qr`,
      init,
    );
  } catch (err) {
    throw new PrintedQrisApiError(
      "network_error",
      err instanceof Error ? err.message : "network error",
    );
  }

  if (response.status === 200) {
    return (await response.json()) as PrintedQrisResponse;
  }
  if (response.status === 404) {
    throw new PrintedQrisApiError("not_found", "outlet has no printed QR configured", 404);
  }
  if (response.status === 401 || response.status === 403) {
    throw new PrintedQrisApiError("unauthorized", "device is not authorised", response.status);
  }
  if (response.status >= 500) {
    throw new PrintedQrisApiError("upstream_error", "server error", response.status);
  }
  throw new PrintedQrisApiError("unknown", `unexpected HTTP ${response.status}`, response.status);
}
