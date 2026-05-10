import type { ShiftCloseResponse, ShiftOpenResponse } from "@kassa/schemas/shifts";

/*
 * Thin client for the cashier shift open/close endpoints (KASA-235).
 *
 * The PWA calls these immediately after enqueuing the corresponding
 * outbox row so the network roundtrip can succeed online — but the
 * outbox + sync runner are the durable layer, so a failure here is
 * never fatal: the row stays queued and the next drain replays.
 */

export const SHIFTS_OPEN_PATH = "/v1/shifts/open";
export const SHIFTS_CLOSE_PATH = "/v1/shifts/close";

export interface ShiftAuth {
  apiKey: string;
  apiSecret: string;
}

export interface ShiftOpenOptions {
  baseUrl: string;
  auth: ShiftAuth;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export type ShiftOpenOnlineResult =
  | { kind: "synced"; response: ShiftOpenResponse }
  | { kind: "queued"; reason: string };

function defaultFetch(): typeof fetch {
  if (typeof fetch !== "function") {
    throw new Error("global fetch is not available; pass options.fetchImpl");
  }
  return fetch;
}

function buildUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

interface ShiftOpenWire {
  openShiftId: string;
  outletId: string;
  cashierStaffId: string;
  businessDate: string;
  openedAt: string;
  openingFloatIdr: number;
}

interface ShiftCloseWire {
  closeShiftId: string;
  openShiftId: string;
  closedAt: string;
  countedCashIdr: number;
}

/**
 * Best-effort online open. The outbox is the source of truth; this just
 * tries to fast-path the network call so the cashier sees an
 * acknowledged shift the moment they tap "Buka shift". On any failure
 * (offline, 5xx, network) the caller leaves the outbox row queued and
 * the sync runner replays.
 */
export async function openShift(
  request: ShiftOpenWire,
  opts: ShiftOpenOptions,
): Promise<ShiftOpenOnlineResult> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const url = buildUrl(opts.baseUrl, SHIFTS_OPEN_PATH);
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
      body: JSON.stringify(request),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    return { kind: "queued", reason: err instanceof Error ? err.message : "network" };
  }
  if (response.ok) {
    const body = (await response.json()) as ShiftOpenResponse;
    return { kind: "synced", response: body };
  }
  // Server-side conflict ⇒ row already exists; the outbox drain will fold
  // this into a `synced` mark on the next cycle. Treat as queued so the
  // UI doesn't surface a confusing error to the cashier.
  return { kind: "queued", reason: `http ${response.status}` };
}

export type ShiftCloseOnlineResult =
  | { kind: "synced"; response: ShiftCloseResponse }
  | { kind: "queued"; reason: string };

export async function closeShift(
  request: ShiftCloseWire,
  opts: ShiftOpenOptions,
): Promise<ShiftCloseOnlineResult> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const url = buildUrl(opts.baseUrl, SHIFTS_CLOSE_PATH);
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
      body: JSON.stringify(request),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    return { kind: "queued", reason: err instanceof Error ? err.message : "network" };
  }
  if (response.ok) {
    const body = (await response.json()) as ShiftCloseResponse;
    return { kind: "synced", response: body };
  }
  return { kind: "queued", reason: `http ${response.status}` };
}
