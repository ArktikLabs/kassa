import type { SaleVoidResponse } from "@kassa/schemas";

/*
 * Thin client for `POST /v1/sales/:saleId/void` (KASA-236-A).
 *
 * Used by the manager-PIN modal as the fast path: a successful online
 * call gives the cashier an immediate Pembatalan-acknowledged result
 * without waiting for the outbox drain. On any failure the outbox row
 * (enqueued before the call) remains queued and the sync runner replays.
 */

export interface VoidSaleAuth {
  apiKey: string;
  apiSecret: string;
}

export interface VoidSaleApiOptions {
  baseUrl: string;
  auth: VoidSaleAuth;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface VoidSaleApiRequest {
  saleId: string;
  localVoidId: string;
  managerStaffId: string;
  managerPin: string;
  voidedAt: string;
  voidBusinessDate: string;
  reason: string | null;
}

export type VoidSaleApiResult =
  | { kind: "synced"; response: SaleVoidResponse }
  | { kind: "manager_pin_required"; status: 403; message: string }
  | { kind: "outside_open_shift"; status: 422; message: string }
  | { kind: "rejected"; status: number; code: string | null; message: string }
  | { kind: "retriable"; status: number; message: string }
  | { kind: "offline"; reason: string };

function defaultFetch(): typeof fetch {
  if (typeof fetch !== "function") {
    throw new Error("global fetch is not available; pass options.fetchImpl");
  }
  return fetch;
}

function buildUrl(baseUrl: string, saleId: string): string {
  return new URL(
    `/v1/sales/${saleId}/void`,
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  ).toString();
}

function isRetriableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status < 600;
}

async function readErrorBody(
  response: Response,
): Promise<{ code: string | null; message: string }> {
  try {
    const body = (await response.clone().json()) as {
      error?: { message?: unknown; code?: unknown };
      message?: unknown;
    };
    const code = typeof body.error?.code === "string" ? body.error.code : null;
    const message =
      typeof body.error?.message === "string"
        ? body.error.message
        : typeof body.message === "string"
          ? body.message
          : `http ${response.status}`;
    return { code, message };
  } catch {
    return { code: null, message: `http ${response.status}` };
  }
}

export async function voidSale(
  request: VoidSaleApiRequest,
  opts: VoidSaleApiOptions,
): Promise<VoidSaleApiResult> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const url = buildUrl(opts.baseUrl, request.saleId);
  const body: Record<string, unknown> = {
    localVoidId: request.localVoidId,
    managerStaffId: request.managerStaffId,
    managerPin: request.managerPin,
    voidedAt: request.voidedAt,
    voidBusinessDate: request.voidBusinessDate,
  };
  if (request.reason !== null) body.reason = request.reason;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-kassa-api-key": opts.auth.apiKey,
        "x-kassa-api-secret": opts.auth.apiSecret,
      },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    return { kind: "offline", reason: err instanceof Error ? err.message : "network" };
  }

  if (response.ok) {
    const parsed = (await response.json()) as SaleVoidResponse;
    return { kind: "synced", response: parsed };
  }
  if (isRetriableStatus(response.status)) {
    const { message } = await readErrorBody(response);
    return { kind: "retriable", status: response.status, message };
  }
  const { code, message } = await readErrorBody(response);
  if (response.status === 403) {
    return { kind: "manager_pin_required", status: 403, message };
  }
  if (response.status === 422 && code === "void_outside_open_shift") {
    return { kind: "outside_open_shift", status: 422, message };
  }
  return { kind: "rejected", status: response.status, code, message };
}
