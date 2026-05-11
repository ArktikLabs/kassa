import type { Database } from "../db/index.ts";
import type { PendingShiftEvent } from "../db/types.ts";

/*
 * Outbox drain for cashier shift open/close events (KASA-235).
 *
 * Mirrors the sale-push contract in `push.ts`:
 *
 *   200/201 → `synced`
 *   409     → `synced`  (server already has the event; idempotency hit)
 *   408/429 → `error`   (retriable; drain halts)
 *   5xx     → `error`   (retriable; drain halts)
 *   4xx     → `needs_attention`
 *   network → `error`
 *
 * Idempotency is enforced server-side on `(merchantId, openShiftId)` for
 * open events and `(merchantId, closeShiftId)` for close events, so a
 * Workbox replay or tab-death retry collapses to the same row.
 */

export const SHIFTS_OPEN_PATH = "/v1/shifts/open";
export const SHIFTS_CLOSE_PATH = "/v1/shifts/close";

export interface PushShiftAuth {
  apiKey: string;
  apiSecret: string;
}

export interface PushShiftOptions {
  baseUrl: string;
  auth?: PushShiftAuth | null;
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
  clock?: () => Date;
  signal?: AbortSignal;
  /** Max rows per drain — same default as the sale-push drain. */
  maxPerDrain?: number;
  /**
   * Hook called after each event is successfully `synced`. Used by the
   * shift-state mirror to flip the local singleton's `serverShiftId` and
   * to clear the row once the close lands. Optional so tests can run the
   * drain without subscribing to the side-channel.
   */
  onEventSynced?: (event: PendingShiftEvent, response: ShiftSyncResponse | null) => Promise<void>;
}

/**
 * Subset of the server's shift response the drain forwards to the
 * `onEventSynced` hook. Re-declared here (instead of importing from
 * `@kassa/schemas`) so the runtime stays tree-shakable and the drain
 * does not pull the full Zod payload into the PWA bundle.
 */
export interface ShiftSyncResponse {
  shiftId: string;
  status: "open" | "closed";
}

export type PushShiftStoppedBy = "completed" | "offline" | "retriable" | "aborted";

export interface PushShiftResult {
  attempted: number;
  synced: number;
  needsAttention: number;
  errored: number;
  stoppedBy: PushShiftStoppedBy;
}

const DEFAULT_MAX_PER_DRAIN = 50;

function defaultFetch(): typeof fetch {
  if (typeof fetch !== "function") {
    throw new Error("global fetch is not available; pass options.fetchImpl");
  }
  return fetch;
}

function defaultIsOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

function isRetriableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status < 600;
}

function buildUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function toOpenWire(row: PendingShiftEvent): Record<string, unknown> {
  if (row.openShiftId === null) {
    throw new Error(`Open event ${row.eventId} is missing openShiftId`);
  }
  if (row.openingFloatIdr === undefined) {
    throw new Error(`Open event ${row.eventId} is missing openingFloatIdr`);
  }
  return {
    openShiftId: row.openShiftId,
    outletId: row.outletId,
    cashierStaffId: row.cashierStaffId,
    businessDate: row.businessDate,
    openedAt: row.occurredAt,
    openingFloatIdr: row.openingFloatIdr,
  };
}

function toCloseWire(row: PendingShiftEvent): Record<string, unknown> {
  if (row.closeShiftId === null) {
    throw new Error(`Close event ${row.eventId} is missing closeShiftId`);
  }
  if (row.openShiftId === null) {
    throw new Error(`Close event ${row.eventId} is missing openShiftId`);
  }
  if (row.countedCashIdr === undefined) {
    throw new Error(`Close event ${row.eventId} is missing countedCashIdr`);
  }
  return {
    closeShiftId: row.closeShiftId,
    openShiftId: row.openShiftId,
    closedAt: row.occurredAt,
    countedCashIdr: row.countedCashIdr,
  };
}

async function readErrorSummary(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as {
      error?: { message?: unknown; code?: unknown };
    };
    const message = typeof body.error?.message === "string" ? body.error.message : null;
    if (message) return `${response.status} ${message}`;
  } catch {
    // fall through
  }
  return fallback;
}

async function readSyncedResponse(response: Response): Promise<ShiftSyncResponse | null> {
  try {
    const body = (await response.clone().json()) as {
      shiftId?: unknown;
      status?: unknown;
    };
    if (typeof body.shiftId === "string" && (body.status === "open" || body.status === "closed")) {
      return { shiftId: body.shiftId, status: body.status };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Drain `pending_shift_events` one event at a time. Returns a summary on
 * every stop reason so the caller can surface state without poking the DB.
 */
export async function pushShiftEvents(
  database: Database,
  opts: PushShiftOptions,
): Promise<PushShiftResult> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const isOnline = opts.isOnline ?? defaultIsOnline;
  const clock = opts.clock ?? (() => new Date());
  const maxPerDrain = opts.maxPerDrain ?? DEFAULT_MAX_PER_DRAIN;
  const repo = database.repos.pendingShiftEvents;
  const signal = opts.signal ?? null;

  if (!isOnline()) {
    return { attempted: 0, synced: 0, needsAttention: 0, errored: 0, stoppedBy: "offline" };
  }

  await repo.resetInFlight();
  const batch = await repo.listDrainable(maxPerDrain);
  const total = batch.length;
  if (total === 0) {
    return { attempted: 0, synced: 0, needsAttention: 0, errored: 0, stoppedBy: "completed" };
  }

  let synced = 0;
  let needsAttention = 0;
  let errored = 0;

  for (let i = 0; i < batch.length; i += 1) {
    const row = batch[i] as PendingShiftEvent;
    if (signal?.aborted) {
      return { attempted: i, synced, needsAttention, errored, stoppedBy: "aborted" };
    }
    if (!isOnline()) {
      return { attempted: i, synced, needsAttention, errored, stoppedBy: "offline" };
    }

    await repo.markSending(row.eventId, clock().toISOString());

    const path = row.kind === "open" ? SHIFTS_OPEN_PATH : SHIFTS_CLOSE_PATH;
    const url = buildUrl(opts.baseUrl, path);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (opts.auth) {
      headers["x-kassa-api-key"] = opts.auth.apiKey;
      headers["x-kassa-api-secret"] = opts.auth.apiSecret;
    }

    let body: Record<string, unknown>;
    try {
      body = row.kind === "open" ? toOpenWire(row) : toCloseWire(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await repo.markNeedsAttention(row.eventId, `payload: ${message}`, clock().toISOString());
      needsAttention += 1;
      continue;
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await repo.markError(row.eventId, `network: ${message}`, clock().toISOString());
      errored += 1;
      return { attempted: i + 1, synced, needsAttention, errored, stoppedBy: "retriable" };
    }

    if (response.ok || response.status === 409) {
      const decoded = await readSyncedResponse(response);
      await repo.markSynced(row.eventId, clock().toISOString());
      if (opts.onEventSynced) await opts.onEventSynced(row, decoded);
      synced += 1;
      continue;
    }
    if (isRetriableStatus(response.status)) {
      const summary = await readErrorSummary(response, `http ${response.status}`);
      await repo.markError(row.eventId, summary, clock().toISOString());
      errored += 1;
      return { attempted: i + 1, synced, needsAttention, errored, stoppedBy: "retriable" };
    }

    const summary = await readErrorSummary(response, `http ${response.status}`);
    await repo.markNeedsAttention(row.eventId, summary, clock().toISOString());
    needsAttention += 1;
  }

  return { attempted: total, synced, needsAttention, errored, stoppedBy: "completed" };
}
