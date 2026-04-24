import type { Database } from "../db/index.ts";
import type { PendingSale } from "../db/types.ts";
import type { SyncStatusStore } from "./status.ts";

/*
 * Outbox drain for pending_sales. ARCHITECTURE §3.1 Flow B.
 *
 * The loop here is the **durable** half of the sale-push story. It reads
 * queued/error rows from the Dexie outbox in createdAt order, POSTs each
 * to `/v1/sales/submit` with its client-generated `local_sale_id`, and
 * moves the row through its terminal state:
 *
 *   200/201 → `synced`  (server name captured from the response body)
 *   409     → `synced`  (server already has the sale; idempotency win)
 *   408/429 → `error`   (retriable; drain halts so workbox backs off)
 *   5xx     → `error`   (retriable; drain halts so workbox backs off)
 *   4xx     → `needs_attention`  (terminal; surfaced in /admin)
 *   network → `error`   (retriable; drain halts)
 *
 * The service worker's `kassa-sales` BackgroundSyncPlugin sits on the same
 * URL (see sw.ts). When the tab dies mid-flight, Workbox clones the
 * pending request into its own IndexedDB and replays on the next `sync`
 * event (i.e. the next SW activation). On replay, the server's
 * idempotency on `local_sale_id` means the duplicate either 200s or 409s,
 * and the next window-side drain reconciles via 409 → `synced`. The two
 * queues cannot disagree because the Dexie row is the single source of
 * truth the UI renders from.
 */

export const SALES_SUBMIT_PATH = "/v1/sales/submit";
export const SALES_QUEUE_NAME = "kassa-sales";

export interface PushAuth {
  apiKey: string;
  apiSecret: string;
}

export interface PushOptions {
  baseUrl: string;
  auth?: PushAuth | null;
  fetchImpl?: typeof fetch;
  status?: SyncStatusStore;
  isOnline?: () => boolean;
  clock?: () => Date;
  signal?: AbortSignal;
  /** Max rows to attempt in a single drain; the rest wait for the next cycle. */
  maxPerDrain?: number;
}

export type PushStoppedBy =
  /** Drain finished: no drainable rows remain (or every row in the batch was dispatched). */
  | "completed"
  /** Device went offline (or was offline on entry). The outbox is untouched. */
  | "offline"
  /** A retriable failure halted the drain; remaining rows stay queued. */
  | "retriable"
  /** The caller's `signal` aborted the drain mid-loop. */
  | "aborted";

export interface PushResult {
  attempted: number;
  synced: number;
  needsAttention: number;
  errored: number;
  stoppedBy: PushStoppedBy;
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

function toWirePayload(row: PendingSale): Record<string, unknown> {
  // `Rupiah` is a branded number — strip the brand for JSON serialization;
  // the API contract is plain `number` (integer IDR).
  return {
    localSaleId: row.localSaleId,
    outletId: row.outletId,
    clerkId: row.clerkId,
    businessDate: row.businessDate,
    createdAt: row.createdAt,
    subtotalIdr: row.subtotalIdr as unknown as number,
    discountIdr: row.discountIdr as unknown as number,
    totalIdr: row.totalIdr as unknown as number,
    items: row.items.map((it) => ({
      itemId: it.itemId,
      bomId: it.bomId,
      quantity: it.quantity,
      uomId: it.uomId,
      unitPriceIdr: it.unitPriceIdr as unknown as number,
      lineTotalIdr: it.lineTotalIdr as unknown as number,
    })),
    tenders: row.tenders.map((t) => ({
      method: t.method,
      amountIdr: t.amountIdr as unknown as number,
      reference: t.reference,
    })),
  };
}

function isRetriableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status < 600;
}

async function readServerName(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { name?: unknown };
    return typeof body.name === "string" && body.name.length > 0 ? body.name : null;
  } catch {
    return null;
  }
}

async function readErrorSummary(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as { message?: unknown; error?: unknown };
    const message =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : null;
    if (message) return `${response.status} ${message}`;
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

function buildUrl(baseUrl: string): string {
  return new URL(SALES_SUBMIT_PATH, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

/**
 * Drain the outbox one call at a time. Returns a summary even on offline
 * or retriable stops so the caller can surface state without inspecting
 * the store.
 *
 * Safe to call concurrently only up to Dexie's row-level row rules — the
 * caller (runner) serializes invocations.
 */
export async function pushOutbox(database: Database, opts: PushOptions): Promise<PushResult> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const isOnline = opts.isOnline ?? defaultIsOnline;
  const clock = opts.clock ?? (() => new Date());
  const maxPerDrain = opts.maxPerDrain ?? DEFAULT_MAX_PER_DRAIN;
  const repo = database.repos.pendingSales;
  const signal = opts.signal ?? null;

  if (!isOnline()) {
    return {
      attempted: 0,
      synced: 0,
      needsAttention: 0,
      errored: 0,
      stoppedBy: "offline",
    };
  }

  // Tab deaths leave rows stuck in `sending` — requeue them so this drain
  // (or the next) can retake ownership. Workbox's BackgroundSyncPlugin may
  // also have replayed them server-side: that's fine, the retry will come
  // back as 409 → `synced`.
  await repo.resetInFlight();

  const batch = await repo.listDrainable(maxPerDrain);
  const total = batch.length;

  const updatePhase = (pending: number) => {
    opts.status?.update((s) => ({
      ...s,
      phase: {
        kind: "syncing",
        table: "pending_sales",
        pending: Math.max(0, pending),
      },
    }));
  };

  if (total === 0) {
    return {
      attempted: 0,
      synced: 0,
      needsAttention: 0,
      errored: 0,
      stoppedBy: "completed",
    };
  }

  updatePhase(total);

  const url = buildUrl(opts.baseUrl);
  let synced = 0;
  let needsAttention = 0;
  let errored = 0;

  for (let i = 0; i < batch.length; i += 1) {
    const row = batch[i] as PendingSale;

    if (signal?.aborted) {
      return {
        attempted: i,
        synced,
        needsAttention,
        errored,
        stoppedBy: "aborted",
      };
    }

    if (!isOnline()) {
      return {
        attempted: i,
        synced,
        needsAttention,
        errored,
        stoppedBy: "offline",
      };
    }

    await repo.markSending(row.localSaleId, clock().toISOString());

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "x-kassa-local-sale-id": row.localSaleId,
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
        body: JSON.stringify(toWirePayload(row)),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await repo.markError(row.localSaleId, `network: ${message}`, clock().toISOString());
      errored += 1;
      return {
        attempted: i + 1,
        synced,
        needsAttention,
        errored,
        stoppedBy: "retriable",
      };
    }

    if (response.ok) {
      const name = await readServerName(response);
      await repo.markSynced(row.localSaleId, name, clock().toISOString());
      synced += 1;
      updatePhase(total - i - 1);
      continue;
    }

    if (response.status === 409) {
      // Server already has the sale (idempotency hit). Its canonical record
      // rides the 409 body; we grab `name` and move on.
      const name = await readServerName(response);
      await repo.markSynced(row.localSaleId, name, clock().toISOString());
      synced += 1;
      updatePhase(total - i - 1);
      continue;
    }

    if (isRetriableStatus(response.status)) {
      const summary = await readErrorSummary(response, `http ${response.status}`);
      await repo.markError(row.localSaleId, summary, clock().toISOString());
      errored += 1;
      return {
        attempted: i + 1,
        synced,
        needsAttention,
        errored,
        stoppedBy: "retriable",
      };
    }

    // Terminal 4xx (validation, auth, not-found…) — mark `needs_attention`
    // and keep draining the rest of the batch. One bad row must not block
    // the queue behind it.
    const summary = await readErrorSummary(response, `http ${response.status}`);
    await repo.markNeedsAttention(row.localSaleId, summary, clock().toISOString());
    needsAttention += 1;
    updatePhase(total - i - 1);
  }

  const finishedAt = clock().toISOString();
  await database.repos.syncState.setLastPushed("pending_sales", finishedAt);

  opts.status?.update((s) => ({
    ...s,
    phase: { kind: "idle", lastSuccessAt: finishedAt, lastError: null },
  }));

  return {
    attempted: total,
    synced,
    needsAttention,
    errored,
    stoppedBy: "completed",
  };
}
