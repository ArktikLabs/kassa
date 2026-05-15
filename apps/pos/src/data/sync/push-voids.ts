import type { Database } from "../db/index.ts";
import type { PendingVoid } from "../db/types.ts";

/*
 * KASA-236-B — outbox drain for sale voids. Mirrors the sale-submit
 * contract in push.ts:
 *
 *   200/201 → `synced`
 *   409     → `needs_attention`  (terminal — `void_idempotency_conflict`
 *                                  means the same localVoidId already
 *                                  exists against a different sale, which
 *                                  is a developer bug, not a retriable
 *                                  network blip)
 *   408/429 → `error`            (retriable; drain halts so the runner
 *                                  backs off)
 *   5xx     → `error`            (retriable; drain halts)
 *   403/422 → `needs_attention`  (manager PIN / shift / business-date
 *                                  violations — clerk re-prompts in UI)
 *   4xx     → `needs_attention`  (everything else terminal)
 *   network → `error`            (retriable; drain halts)
 *
 * Idempotency is enforced server-side on `localVoidId`; a Workbox replay
 * or tab-death retry collapses to the same row.
 */

export const SALES_VOID_PATH = (saleId: string) => `/v1/sales/${saleId}/void`;

export interface PushVoidAuth {
  apiKey: string;
  apiSecret: string;
}

export interface PushVoidOptions {
  baseUrl: string;
  auth?: PushVoidAuth | null;
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
  clock?: () => Date;
  signal?: AbortSignal;
  maxPerDrain?: number;
  /**
   * Hook called after a void is successfully `synced`. Used to flip the
   * local `pending_sales` row's `voidedAt`/`voidBusinessDate` so the
   * receipt preview / history list render the PEMBATALAN banner without
   * waiting for the next reference-data pull.
   */
  onVoidSynced?: (row: PendingVoid) => Promise<void>;
}

export type PushVoidStoppedBy = "completed" | "offline" | "retriable" | "aborted";

export interface PushVoidResult {
  attempted: number;
  synced: number;
  needsAttention: number;
  errored: number;
  stoppedBy: PushVoidStoppedBy;
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

function toWire(row: PendingVoid): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    localVoidId: row.localVoidId,
    managerStaffId: row.managerStaffId,
    managerPin: row.managerPin,
    voidedAt: row.voidedAt,
    voidBusinessDate: row.voidBusinessDate,
  };
  if (row.reason !== null) payload.reason = row.reason;
  return payload;
}

async function readErrorSummary(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as {
      error?: { message?: unknown; code?: unknown };
      message?: unknown;
    };
    const message =
      typeof body.error?.message === "string"
        ? body.error.message
        : typeof body.message === "string"
          ? body.message
          : null;
    if (message) return `${response.status} ${message}`;
  } catch {
    // fall through
  }
  return fallback;
}

export async function pushVoids(
  database: Database,
  opts: PushVoidOptions,
): Promise<PushVoidResult> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const isOnline = opts.isOnline ?? defaultIsOnline;
  const clock = opts.clock ?? (() => new Date());
  const maxPerDrain = opts.maxPerDrain ?? DEFAULT_MAX_PER_DRAIN;
  const repo = database.repos.pendingVoids;
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
    const row = batch[i] as PendingVoid;
    if (signal?.aborted) {
      return { attempted: i, synced, needsAttention, errored, stoppedBy: "aborted" };
    }
    if (!isOnline()) {
      return { attempted: i, synced, needsAttention, errored, stoppedBy: "offline" };
    }

    await repo.markSending(row.localVoidId, clock().toISOString());

    const url = buildUrl(opts.baseUrl, SALES_VOID_PATH(row.saleId));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (opts.auth) {
      headers["x-kassa-api-key"] = opts.auth.apiKey;
      headers["x-kassa-api-secret"] = opts.auth.apiSecret;
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(toWire(row)),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await repo.markError(row.localVoidId, `network: ${message}`, clock().toISOString());
      errored += 1;
      return { attempted: i + 1, synced, needsAttention, errored, stoppedBy: "retriable" };
    }

    if (response.ok) {
      await repo.markSynced(row.localVoidId, clock().toISOString());
      if (opts.onVoidSynced) await opts.onVoidSynced(row);
      synced += 1;
      continue;
    }

    if (isRetriableStatus(response.status)) {
      const summary = await readErrorSummary(response, `http ${response.status}`);
      await repo.markError(row.localVoidId, summary, clock().toISOString());
      errored += 1;
      return { attempted: i + 1, synced, needsAttention, errored, stoppedBy: "retriable" };
    }

    // Terminal 4xx (403 manager-PIN, 409 idempotency, 422 outside-open-shift…)
    const summary = await readErrorSummary(response, `http ${response.status}`);
    await repo.markNeedsAttention(row.localVoidId, summary, clock().toISOString());
    needsAttention += 1;
  }

  return { attempted: total, synced, needsAttention, errored, stoppedBy: "completed" };
}
