import type { Database } from "../db/index.ts";
import type { PendingCatalogMutation } from "../db/types.ts";
import type { PushAuth, PushResult, PushStoppedBy } from "./push.ts";

/*
 * Outbox drain for `pending_catalog_mutations` (KASA-248).
 *
 * Mirrors the pending-sales drain shape (push.ts) so the runner's
 * lifecycle/auth wiring stays uniform. One row per item id; status
 * transitions:
 *
 *   200/204 → `synced` (row deleted; server is canonical)
 *   408/429 → `error`  (retriable; halts drain so workbox backs off)
 *   5xx     → `error`  (retriable; halts drain)
 *   4xx     → `needs_attention` (terminal validation/auth failure)
 *   network → `error`  (retriable; halts drain)
 *
 * The PATCH is naturally idempotent on the (itemId, availability) pair
 * — replays produce the same server state — so the SW Background Sync
 * plugin replaying an in-flight request after a tab kill is safe.
 */

const CATALOG_PATCH_PATH_PREFIX = "/v1/catalog/items/";
export const CATALOG_QUEUE_NAME = "kassa-catalog-mutations";

export interface PushCatalogOptions {
  baseUrl: string;
  auth?: PushAuth | null;
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
  clock?: () => Date;
  signal?: AbortSignal;
  maxPerDrain?: number;
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

function buildUrl(baseUrl: string, itemId: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`${CATALOG_PATCH_PATH_PREFIX.slice(1)}${itemId}`, base).toString();
}

async function readErrorSummary(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown; message?: unknown };
      message?: unknown;
    };
    const code = typeof body.error?.code === "string" ? body.error.code : null;
    const message =
      typeof body.error?.message === "string"
        ? body.error.message
        : typeof body.message === "string"
          ? body.message
          : null;
    if (code && message) return `${response.status} ${code}: ${message}`;
    if (message) return `${response.status} ${message}`;
    if (code) return `${response.status} ${code}`;
  } catch {
    // fall through to text
  }
  try {
    const text = await response.clone().text();
    if (text.length > 0) return `${response.status} ${text.slice(0, 200)}`;
  } catch {
    // ignore
  }
  return fallback;
}

export async function pushCatalogMutations(
  database: Database,
  opts: PushCatalogOptions,
): Promise<PushResult> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const isOnline = opts.isOnline ?? defaultIsOnline;
  const clock = opts.clock ?? (() => new Date());
  const maxPerDrain = opts.maxPerDrain ?? DEFAULT_MAX_PER_DRAIN;
  const repo = database.repos.pendingCatalogMutations;
  const signal = opts.signal ?? null;

  if (!isOnline()) {
    return baseResult(0, 0, 0, 0, "offline");
  }

  await repo.resetInFlight();

  const batch: PendingCatalogMutation[] = await repo.listDrainable(maxPerDrain);
  const total = batch.length;

  if (total === 0) {
    return baseResult(0, 0, 0, 0, "completed");
  }

  let synced = 0;
  let needsAttention = 0;
  let errored = 0;

  for (let i = 0; i < batch.length; i += 1) {
    const row = batch[i] as PendingCatalogMutation;

    if (signal?.aborted) {
      return baseResult(i, synced, needsAttention, errored, "aborted");
    }
    if (!isOnline()) {
      return baseResult(i, synced, needsAttention, errored, "offline");
    }

    await repo.markSending(row.itemId, clock().toISOString());

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
      response = await fetchImpl(buildUrl(opts.baseUrl, row.itemId), {
        method: "PATCH",
        headers,
        body: JSON.stringify({ availability: row.availability }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await repo.markError(row.itemId, `network: ${message}`, clock().toISOString());
      errored += 1;
      return baseResult(i + 1, synced, needsAttention, errored, "retriable");
    }

    if (response.ok) {
      await repo.markSynced(row.itemId);
      synced += 1;
      continue;
    }

    if (isRetriableStatus(response.status)) {
      const summary = await readErrorSummary(response, `http ${response.status}`);
      await repo.markError(row.itemId, summary, clock().toISOString());
      errored += 1;
      return baseResult(i + 1, synced, needsAttention, errored, "retriable");
    }

    const summary = await readErrorSummary(response, `http ${response.status}`);
    await repo.markNeedsAttention(row.itemId, summary, clock().toISOString());
    needsAttention += 1;
  }

  return baseResult(total, synced, needsAttention, errored, "completed");
}

function baseResult(
  attempted: number,
  synced: number,
  needsAttention: number,
  errored: number,
  stoppedBy: PushStoppedBy,
): PushResult {
  return { attempted, synced, needsAttention, errored, stoppedBy };
}
