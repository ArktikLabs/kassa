import type { z } from "zod";
import {
  bomPullResponse,
  itemPullResponse,
  outletPullResponse,
  stockPullResponse,
  uomPullResponse,
  type BomRecord,
  type ItemRecord,
  type OutletRecord,
  type StockSnapshotRecord,
  type UomRecord,
} from "@kassa/schemas";
import type { Table } from "dexie";
import type { Database } from "../db/index.ts";
import type { KassaDexie } from "../db/schema.ts";
import { toRupiah } from "../../shared/money/index.ts";
import type { Bom, Item, Outlet, ReferenceTable, StockSnapshot, Uom } from "../db/types.ts";
import { stockSnapshotKey } from "../db/types.ts";
import { SyncHttpError, SyncNetworkError, SyncOfflineError, SyncParseError } from "./errors.ts";
import { computeBackoffMs, sleep, type BackoffOptions } from "./backoff.ts";
import type { SyncStatusStore } from "./status.ts";

export const PULL_ORDER: readonly ReferenceTable[] = [
  "outlets",
  "items",
  "boms",
  "uoms",
  "stock_snapshot",
] as const;

export interface PullOptions {
  baseUrl: string;
  outletId: string | null;
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
  clock?: () => Date;
  backoff?: BackoffOptions;
  maxRetries?: number;
  signal?: AbortSignal;
  status?: SyncStatusStore;
  auth?: { apiKey: string; apiSecret: string } | null;
  onSentryError?: (err: SyncParseError) => void;
}

export interface PullTableResult {
  table: ReferenceTable;
  batches: number;
  records: number;
  cursor: string | null;
  skipped?: boolean;
}

export interface PullAllResult {
  tables: PullTableResult[];
  startedAt: string;
  finishedAt: string;
}

const MAX_RETRIES_DEFAULT = 6;

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

function topLevelKeys(value: unknown): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>).sort();
  }
  return [];
}

type AnyTable = Table<unknown, unknown, unknown>;
type PullEnvelope<TRecord> = {
  records: TRecord[];
  nextCursor: string | null;
  nextPageToken: string | null;
};

interface TableSpec<TRecord, TRow> {
  table: ReferenceTable;
  path: string;
  schema: z.ZodType<PullEnvelope<TRecord>>;
  requiresOutlet?: boolean;
  toRows: (records: readonly TRecord[]) => TRow[];
  upsert: (db: KassaDexie, rows: readonly TRow[]) => Promise<void>;
  targetTable: (db: KassaDexie) => AnyTable;
}

type AnySpec =
  | TableSpec<OutletRecord, Outlet>
  | TableSpec<ItemRecord, Item>
  | TableSpec<BomRecord, Bom>
  | TableSpec<UomRecord, Uom>
  | TableSpec<StockSnapshotRecord, StockSnapshot>;

type SpecMap = {
  outlets: TableSpec<OutletRecord, Outlet>;
  items: TableSpec<ItemRecord, Item>;
  boms: TableSpec<BomRecord, Bom>;
  uoms: TableSpec<UomRecord, Uom>;
  stock_snapshot: TableSpec<StockSnapshotRecord, StockSnapshot>;
};

function buildTableSpecs(): SpecMap {
  return {
    outlets: {
      table: "outlets",
      path: "/v1/outlets",
      schema: outletPullResponse as unknown as z.ZodType<PullEnvelope<OutletRecord>>,
      toRows: (records) => records.map((r) => ({ ...r })),
      upsert: async (db, rows) => {
        if (rows.length === 0) return;
        await db.outlets.bulkPut([...rows]);
      },
      targetTable: (db) => db.outlets as unknown as AnyTable,
    },
    items: {
      table: "items",
      path: "/v1/catalog/items",
      schema: itemPullResponse as unknown as z.ZodType<PullEnvelope<ItemRecord>>,
      toRows: (records) =>
        records.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          priceIdr: toRupiah(r.priceIdr),
          uomId: r.uomId,
          bomId: r.bomId,
          isStockTracked: r.isStockTracked,
          isActive: r.isActive,
          updatedAt: r.updatedAt,
        })),
      upsert: async (db, rows) => {
        if (rows.length === 0) return;
        await db.items.bulkPut([...rows]);
      },
      targetTable: (db) => db.items as unknown as AnyTable,
    },
    boms: {
      table: "boms",
      path: "/v1/catalog/boms",
      schema: bomPullResponse as unknown as z.ZodType<PullEnvelope<BomRecord>>,
      toRows: (records) => records.map((r) => ({ ...r })),
      upsert: async (db, rows) => {
        if (rows.length === 0) return;
        await db.boms.bulkPut([...rows]);
      },
      targetTable: (db) => db.boms as unknown as AnyTable,
    },
    uoms: {
      table: "uoms",
      path: "/v1/catalog/uoms",
      schema: uomPullResponse as unknown as z.ZodType<PullEnvelope<UomRecord>>,
      toRows: (records) => records.map((r) => ({ ...r })),
      upsert: async (db, rows) => {
        if (rows.length === 0) return;
        await db.uoms.bulkPut([...rows]);
      },
      targetTable: (db) => db.uoms as unknown as AnyTable,
    },
    stock_snapshot: {
      table: "stock_snapshot",
      path: "/v1/stock/snapshot",
      schema: stockPullResponse as unknown as z.ZodType<PullEnvelope<StockSnapshotRecord>>,
      requiresOutlet: true,
      toRows: (records) =>
        records.map((r) => ({
          key: stockSnapshotKey(r.outletId, r.itemId),
          outletId: r.outletId,
          itemId: r.itemId,
          onHand: r.onHand,
          updatedAt: r.updatedAt,
        })),
      upsert: async (db, rows) => {
        if (rows.length === 0) return;
        await db.stock_snapshot.bulkPut([...rows]);
      },
      targetTable: (db) => db.stock_snapshot as unknown as AnyTable,
    },
  };
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: { cursor: string | null; pageToken: string | null; outletId?: string },
): string {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (query.cursor) url.searchParams.set("updated_after", query.cursor);
  if (query.pageToken) url.searchParams.set("page_token", query.pageToken);
  if (query.outletId) url.searchParams.set("outlet", query.outletId);
  return url.toString();
}

async function fetchPage<TRecord>(
  spec: TableSpec<TRecord, unknown>,
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | null,
  auth: { apiKey: string; apiSecret: string } | null,
): Promise<PullEnvelope<TRecord>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (auth) {
    headers["x-kassa-api-key"] = auth.apiKey;
    headers["x-kassa-api-secret"] = auth.apiSecret;
  }
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers, signal });
  } catch (err) {
    throw new SyncNetworkError(spec.table, `network error pulling ${spec.table}`, {
      cause: err,
    });
  }
  if (!response.ok) {
    throw new SyncHttpError(
      spec.table,
      response.status,
      `HTTP ${response.status} pulling ${spec.table}`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new SyncParseError(spec.table, `invalid JSON from ${spec.table}`, {
      issueSummary: "response body was not valid JSON",
      receivedKeys: [],
      cause: err,
    });
  }
  const parsed = spec.schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const summary = issue
      ? `${issue.path.join(".") || "<root>"}: ${issue.code}`
      : "unknown parse error";
    throw new SyncParseError(spec.table, `parse failure on ${spec.table}`, {
      issueSummary: summary,
      receivedKeys: topLevelKeys(body),
      cause: parsed.error,
    });
  }
  return parsed.data;
}

async function pullOneTable(
  spec: AnySpec,
  db: KassaDexie,
  opts: PullOptions,
): Promise<PullTableResult> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const isOnline = opts.isOnline ?? defaultIsOnline;
  const clock = opts.clock ?? (() => new Date());
  const maxRetries = opts.maxRetries ?? MAX_RETRIES_DEFAULT;
  const auth = opts.auth ?? null;
  const signal: AbortSignal | null = opts.signal ?? null;

  if (spec.requiresOutlet && !opts.outletId) {
    return {
      table: spec.table,
      batches: 0,
      records: 0,
      cursor: null,
      skipped: true,
    };
  }

  const initialState = await db.sync_state.get(spec.table);
  let cursor: string | null = initialState?.cursor ?? null;
  let pageToken: string | null = null;
  let batches = 0;
  let records = 0;
  let attempt = 0;

  for (;;) {
    signal?.throwIfAborted();
    if (!isOnline()) throw new SyncOfflineError();
    const url = buildUrl(opts.baseUrl, spec.path, {
      cursor,
      pageToken,
      ...(spec.requiresOutlet && opts.outletId ? { outletId: opts.outletId } : {}),
    });
    let page: PullEnvelope<unknown>;
    try {
      page = await fetchPage(spec as TableSpec<unknown, unknown>, url, fetchImpl, signal, auth);
      attempt = 0;
    } catch (err) {
      if (err instanceof SyncParseError) {
        opts.onSentryError?.(err);
        throw err;
      }
      const retryable =
        err instanceof SyncNetworkError || (err instanceof SyncHttpError && err.retryable);
      if (!retryable) throw err;
      attempt += 1;
      if (attempt > maxRetries) throw err;
      const delayMs = computeBackoffMs(attempt, opts.backoff ?? {});
      await sleep(delayMs, signal ?? undefined);
      continue;
    }

    const rows = (spec.toRows as (r: readonly unknown[]) => unknown[])(page.records);
    const nowIso = clock().toISOString();
    const nextCursor = page.nextPageToken ? cursor : (page.nextCursor ?? cursor);
    await db.transaction("rw", spec.targetTable(db), db.sync_state, async () => {
      await (spec.upsert as (db: KassaDexie, rows: readonly unknown[]) => Promise<void>)(db, rows);
      const existing = await db.sync_state.get(spec.table);
      await db.sync_state.put({
        table: spec.table,
        cursor: nextCursor,
        lastPulledAt: nowIso,
        lastPushedAt: existing?.lastPushedAt ?? null,
      });
    });
    batches += 1;
    records += rows.length;
    cursor = nextCursor;
    pageToken = page.nextPageToken;
    if (!page.nextPageToken) break;
  }

  return { table: spec.table, batches, records, cursor };
}

export async function pullAll(database: Database, opts: PullOptions): Promise<PullAllResult> {
  const clock = opts.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const isOnline = opts.isOnline ?? defaultIsOnline;
  if (!isOnline()) throw new SyncOfflineError();

  const specs = buildTableSpecs();
  const db = database.db;
  const results: PullTableResult[] = [];

  for (const table of PULL_ORDER) {
    opts.signal?.throwIfAborted();
    opts.status?.update((s) => ({
      ...s,
      phase: {
        kind: "syncing",
        table,
        pending: Math.max(1, PULL_ORDER.length - results.length),
      },
    }));
    const spec = specs[table];
    const result = await pullOneTable(spec, db, opts);
    results.push(result);
  }

  const finishedAt = clock().toISOString();
  opts.status?.set({
    phase: { kind: "idle", lastSuccessAt: finishedAt, lastError: null },
  });
  return { tables: results, startedAt, finishedAt };
}
