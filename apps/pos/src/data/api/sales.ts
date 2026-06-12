/*
 * Sales lookup API client. Only `findSaleByReceiptCode` exists today
 * (KASA-370 cross-device find-sale fallback): the counter tablet hits
 * `GET /v1/sales?outletId=&receiptCode=` when its same-device Dexie
 * miss could still belong to a sibling tablet at the same outlet — the
 * customer rang on the kitchen device and walked over to the counter.
 *
 * The route returns the same `saleResponse` shape as `GET /v1/sales/{id}`
 * on a hit or 404 `sale_not_found` on miss. Errors mirror the enrolment /
 * QRIS clients: synthetic `network_error` when fetch rejects (offline,
 * CORS, DNS), HTTP status code otherwise.
 */
import type { SaleResponse } from "@kassa/schemas";
import { apiBaseUrl } from "./config";

export type SalesLookupErrorCode =
  | "not_found"
  | "unauthorized"
  | "bad_request"
  | "network_error"
  | "unknown";

export class SalesLookupApiError extends Error {
  readonly code: SalesLookupErrorCode;
  readonly status: number | null;

  constructor(code: SalesLookupErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "SalesLookupApiError";
    this.code = code;
    this.status = status;
  }
}

export interface FindRemoteSaleByReceiptCodeInput {
  outletId: string;
  receiptCode: string;
  auth: { apiKey: string; apiSecret: string };
}

export interface FindRemoteSaleByReceiptCodeOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Returns the server's canonical sale envelope when the (outletId,
 * receiptCode) pair matches a sale on the caller's merchant; returns null
 * on 404 (the cashier sees the same "Struk tidak ditemukan." dead-end as
 * if the code was never issued). Any other failure throws a
 * `SalesLookupApiError` so the caller can decide whether to fall back to
 * the offline panel.
 */
export async function findRemoteSaleByReceiptCode(
  input: FindRemoteSaleByReceiptCodeInput,
  options: FindRemoteSaleByReceiptCodeOptions = {},
): Promise<SaleResponse | null> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url =
    `${apiBaseUrl()}/v1/sales` +
    `?outletId=${encodeURIComponent(input.outletId)}` +
    `&receiptCode=${encodeURIComponent(input.receiptCode)}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-kassa-api-key": input.auth.apiKey,
    "x-kassa-api-secret": input.auth.apiSecret,
  };
  let response: Response;
  try {
    const init: RequestInit = { method: "GET", headers };
    if (options.signal) init.signal = options.signal;
    response = await doFetch(url, init);
  } catch (err) {
    throw new SalesLookupApiError(
      "network_error",
      err instanceof Error ? err.message : "network error",
    );
  }
  if (response.status === 200) {
    return (await response.json()) as SaleResponse;
  }
  if (response.status === 404) {
    return null;
  }
  if (response.status === 401) {
    throw new SalesLookupApiError("unauthorized", "Device session expired.", 401);
  }
  if (response.status === 422 || response.status === 400) {
    throw new SalesLookupApiError(
      "bad_request",
      `Invalid lookup (status ${response.status}).`,
      response.status,
    );
  }
  throw new SalesLookupApiError(
    "unknown",
    `Unexpected status ${response.status} from /v1/sales lookup.`,
    response.status,
  );
}
