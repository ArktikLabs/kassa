/*
 * QRIS tender API client (ARCHITECTURE.md §3.1 Flow C). `createQrisOrder`
 * opens the tender — it MUST be online because Midtrans issues the EMV QR
 * and the sale cannot progress until it is rendered. `getQrisOrderStatus`
 * is polled every 3 s by the tender panel until the provider reports a
 * terminal state (`paid`, `expired`, `cancelled`, `failed`).
 *
 * Error taxonomy mirrors `enrolment.ts`: a synthetic `network_error` when
 * fetch rejects (the PWA is offline or DNS is down — the UI surfaces the
 * "Offline — gunakan QRIS statis" fallback link), real HTTP status codes
 * otherwise.
 */
import { apiBaseUrl } from "./config";

export type QrisOrderStatusName = "pending" | "paid" | "expired" | "cancelled" | "failed";

export interface CreateQrisOrderRequest {
  amount: number;
  localSaleId: string;
  outletId: string;
  expiryMinutes?: number;
}

export interface CreateQrisOrderResponse {
  qrisOrderId: string;
  qrString: string;
  expiresAt: string | null;
}

export interface QrisOrderStatusResponseBody {
  qrisOrderId: string;
  status: QrisOrderStatusName;
  grossAmount: number;
  paidAt: string | null;
}

export type QrisApiErrorCode =
  | "bad_request"
  | "payments_unavailable"
  | "upstream_error"
  | "network_error"
  | "unknown";

export class QrisApiError extends Error {
  readonly code: QrisApiErrorCode;
  readonly status: number | null;

  constructor(code: QrisApiErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "QrisApiError";
    this.code = code;
    this.status = status;
  }
}

interface FetchOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function createQrisOrder(
  input: CreateQrisOrderRequest,
  options: FetchOptions = {},
): Promise<CreateQrisOrderResponse> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    };
    if (options.signal) init.signal = options.signal;
    response = await doFetch(`${apiBaseUrl()}/v1/payments/qris`, init);
  } catch (err) {
    throw new QrisApiError("network_error", err instanceof Error ? err.message : "network error");
  }

  if (response.status === 201) {
    return (await response.json()) as CreateQrisOrderResponse;
  }
  throw await buildApiError(response);
}

export async function getQrisOrderStatus(
  qrisOrderId: string,
  options: FetchOptions = {},
): Promise<QrisOrderStatusResponseBody> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    const init: RequestInit = { method: "GET" };
    if (options.signal) init.signal = options.signal;
    response = await doFetch(
      `${apiBaseUrl()}/v1/payments/qris/${encodeURIComponent(qrisOrderId)}/status`,
      init,
    );
  } catch (err) {
    throw new QrisApiError("network_error", err instanceof Error ? err.message : "network error");
  }

  if (response.status === 200) {
    return (await response.json()) as QrisOrderStatusResponseBody;
  }
  throw await buildApiError(response);
}

async function buildApiError(response: Response): Promise<QrisApiError> {
  let code: QrisApiErrorCode = "unknown";
  let message = `qris request failed (HTTP ${response.status})`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    const bodyCode = body.error?.code;
    if (bodyCode === "payments_unavailable" || bodyCode === "bad_request") {
      code = bodyCode;
    } else if (response.status >= 500) {
      code = "upstream_error";
    }
    if (typeof body.error?.message === "string" && body.error.message.length > 0) {
      message = body.error.message;
    }
  } catch {
    if (response.status >= 500) code = "upstream_error";
  }
  return new QrisApiError(code, message, response.status);
}
