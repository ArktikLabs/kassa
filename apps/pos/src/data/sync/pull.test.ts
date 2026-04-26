import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { createRepos, DB_NAME } from "../db/index.ts";
import { type KassaDexie, openKassaDb } from "../db/schema.ts";
import { createSyncStatusStore } from "./status.ts";
import { pullAll, PULL_ORDER } from "./pull.ts";
import { SyncHttpError, SyncOfflineError, SyncParseError } from "./errors.ts";

const OUTLET_ID = "018f9c1a-4b2e-7c00-b000-000000000001";
const UOM_ID = "018f9c1a-4b2e-7c00-b000-000000000100";
const ITEM_ID = "018f9c1a-4b2e-7c00-b000-000000000200";
const BOM_ID = "018f9c1a-4b2e-7c00-b000-000000000300";
const COMPONENT_ID = "018f9c1a-4b2e-7c00-b000-000000000400";

function emptyPageBody() {
  return { records: [], nextCursor: null, nextPageToken: null };
}

function outletBody() {
  return {
    records: [
      {
        id: OUTLET_ID,
        code: "JKT-01",
        name: "Jakarta Selatan",
        timezone: "Asia/Jakarta",
        updatedAt: "2026-04-24T01:00:00Z",
      },
    ],
    nextCursor: "2026-04-24T01:00:00Z",
    nextPageToken: null,
  };
}

function itemBody() {
  return {
    records: [
      {
        id: ITEM_ID,
        code: "ITM-01",
        name: "Es teh manis",
        priceIdr: 5000,
        uomId: UOM_ID,
        bomId: null,
        isStockTracked: true,
        isActive: true,
        updatedAt: "2026-04-24T01:00:00Z",
      },
    ],
    nextCursor: "2026-04-24T01:00:00Z",
    nextPageToken: null,
  };
}

function bomBody() {
  return {
    records: [
      {
        id: BOM_ID,
        itemId: ITEM_ID,
        components: [{ componentItemId: COMPONENT_ID, quantity: 2, uomId: UOM_ID }],
        updatedAt: "2026-04-24T01:00:00Z",
      },
    ],
    nextCursor: "2026-04-24T01:00:00Z",
    nextPageToken: null,
  };
}

function uomBody() {
  return {
    records: [
      {
        id: UOM_ID,
        code: "pcs",
        name: "pieces",
        updatedAt: "2026-04-24T01:00:00Z",
      },
    ],
    nextCursor: "2026-04-24T01:00:00Z",
    nextPageToken: null,
  };
}

function stockBody() {
  return {
    records: [
      {
        outletId: OUTLET_ID,
        itemId: ITEM_ID,
        onHand: 42,
        updatedAt: "2026-04-24T01:00:00Z",
      },
    ],
    nextCursor: "2026-04-24T01:00:00Z",
    nextPageToken: null,
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function defaultBodyFor(pathname: string): unknown {
  if (pathname === "/v1/outlets") return outletBody();
  if (pathname === "/v1/catalog/items") return itemBody();
  if (pathname === "/v1/catalog/boms") return bomBody();
  if (pathname === "/v1/catalog/uoms") return uomBody();
  if (pathname === "/v1/stock/snapshot") return stockBody();
  throw new Error(`unexpected path ${pathname}`);
}

async function freshDatabase() {
  const name = `${DB_NAME}-test-${Math.random().toString(36).slice(2)}`;
  await Dexie.delete(name);
  const db = (await openKassaDb(name)) as KassaDexie;
  return {
    name,
    db,
    repos: createRepos(db),
    close: () => db.close(),
  };
}

describe("pullAll", () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>;
  const clock = () => new Date("2026-04-24T02:00:00Z");

  beforeEach(async () => {
    database = await freshDatabase();
  });

  afterEach(async () => {
    database.close();
    await Dexie.delete(database.name);
  });

  it("runs the first pull with no cursor, upserts rows, and writes cursors", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      const { pathname } = new URL(url);
      return jsonResponse(defaultBodyFor(pathname));
    }) as unknown as typeof fetch;

    const result = await pullAll(database, {
      baseUrl: "https://api.kassa.test",
      outletId: OUTLET_ID,
      fetchImpl,
      clock,
      isOnline: () => true,
    });

    expect(result.tables.map((t) => t.table)).toEqual([...PULL_ORDER]);
    expect(result.tables.every((t) => !t.skipped)).toBe(true);
    expect(calls).toHaveLength(5);
    for (const url of calls) {
      expect(new URL(url).searchParams.has("updatedAfter")).toBe(false);
    }
    expect(new URL(calls[4] as string).searchParams.get("outlet")).toBe(OUTLET_ID);

    const outlets = await database.repos.outlets.all();
    expect(outlets).toHaveLength(1);
    const items = await database.repos.items.listActive();
    expect(items[0]?.priceIdr).toBe(5000);
    const cursor = await database.repos.syncState.get("items");
    expect(cursor?.cursor).toBe("2026-04-24T01:00:00Z");
    expect(cursor?.lastPulledAt).toBe("2026-04-24T02:00:00.000Z");
  });

  it("passes the stored cursor to the next pull (delta)", async () => {
    await database.repos.syncState.setPullCursor(
      "items",
      "2026-04-20T00:00:00Z",
      "2026-04-20T00:00:00Z",
    );
    const capturedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrls.push(url);
      const { pathname } = new URL(url);
      return jsonResponse(defaultBodyFor(pathname));
    }) as unknown as typeof fetch;

    await pullAll(database, {
      baseUrl: "https://api.kassa.test",
      outletId: OUTLET_ID,
      fetchImpl,
      clock,
      isOnline: () => true,
    });

    const itemsCall = capturedUrls.find((u) => u.includes("/v1/catalog/items"));
    expect(itemsCall).toBeDefined();
    expect(new URL(itemsCall as string).searchParams.get("updatedAfter")).toBe(
      "2026-04-20T00:00:00Z",
    );
  });

  it("throws SyncParseError and invokes onSentryError when payload is malformed", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const { pathname } = new URL(url);
      if (pathname === "/v1/catalog/items") {
        return jsonResponse({
          records: [
            {
              id: ITEM_ID,
              code: "ITM-01",
              name: "Es teh",
              priceIdr: "not-a-number",
              uomId: UOM_ID,
              bomId: null,
              isStockTracked: true,
              isActive: true,
              updatedAt: "2026-04-24T01:00:00Z",
            },
          ],
          nextCursor: null,
          nextPageToken: null,
        });
      }
      return jsonResponse(defaultBodyFor(pathname));
    }) as unknown as typeof fetch;

    const onSentryError = vi.fn();
    await expect(
      pullAll(database, {
        baseUrl: "https://api.kassa.test",
        outletId: OUTLET_ID,
        fetchImpl,
        clock,
        isOnline: () => true,
        onSentryError,
      }),
    ).rejects.toBeInstanceOf(SyncParseError);
    expect(onSentryError).toHaveBeenCalledOnce();
    const parseErr = onSentryError.mock.calls[0]?.[0] as SyncParseError;
    expect(parseErr.table).toBe("items");
    expect(parseErr.receivedKeys).toEqual(["nextCursor", "nextPageToken", "records"]);

    const items = await database.repos.items.listActive();
    expect(items).toHaveLength(0);
    const itemsCursor = await database.repos.syncState.get("items");
    expect(itemsCursor).toBeUndefined();
  });

  it("retries 5xx responses with backoff and eventually succeeds", async () => {
    let outletAttempts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const { pathname } = new URL(url);
      if (pathname === "/v1/outlets") {
        outletAttempts += 1;
        if (outletAttempts < 3) {
          return jsonResponse({ error: "boom" }, { status: 503 });
        }
      }
      return jsonResponse(defaultBodyFor(pathname));
    }) as unknown as typeof fetch;

    const result = await pullAll(database, {
      baseUrl: "https://api.kassa.test",
      outletId: OUTLET_ID,
      fetchImpl,
      clock,
      isOnline: () => true,
      backoff: { random: () => 0 },
    });

    expect(outletAttempts).toBe(3);
    expect(result.tables.find((t) => t.table === "outlets")?.batches).toBe(1);
  });

  it("gives up with SyncHttpError after exceeding maxRetries", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "still-boom" }, { status: 502 }),
    ) as unknown as typeof fetch;

    await expect(
      pullAll(database, {
        baseUrl: "https://api.kassa.test",
        outletId: OUTLET_ID,
        fetchImpl,
        clock,
        isOnline: () => true,
        maxRetries: 1,
        backoff: { random: () => 0 },
      }),
    ).rejects.toBeInstanceOf(SyncHttpError);
  });

  it("is a no-op when offline", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      pullAll(database, {
        baseUrl: "https://api.kassa.test",
        outletId: OUTLET_ID,
        fetchImpl,
        clock,
        isOnline: () => false,
      }),
    ).rejects.toBeInstanceOf(SyncOfflineError);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("emits syncing status with Sinkronisasi · N pending batches", async () => {
    const status = createSyncStatusStore();
    const phases: Array<{ kind: string; table?: string | null; pending?: number }> = [];
    status.subscribe((s) => {
      if (s.phase.kind === "syncing") {
        phases.push({
          kind: s.phase.kind,
          table: s.phase.table,
          pending: s.phase.pending,
        });
      } else {
        phases.push({ kind: s.phase.kind });
      }
    });

    const fetchImpl = vi.fn(async (url: string) => {
      const { pathname } = new URL(url);
      return jsonResponse(defaultBodyFor(pathname));
    }) as unknown as typeof fetch;

    await pullAll(database, {
      baseUrl: "https://api.kassa.test",
      outletId: OUTLET_ID,
      fetchImpl,
      clock,
      isOnline: () => true,
      status,
    });

    const syncing = phases.filter((p) => p.kind === "syncing");
    expect(syncing).toHaveLength(PULL_ORDER.length);
    expect(syncing[0]?.pending).toBe(PULL_ORDER.length);
    expect(syncing.at(-1)?.pending).toBe(1);
    expect(phases.at(-1)?.kind).toBe("idle");
  });

  it("skips stock_snapshot when outletId is not known", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const { pathname } = new URL(url);
      return jsonResponse(defaultBodyFor(pathname));
    }) as unknown as typeof fetch;

    const result = await pullAll(database, {
      baseUrl: "https://api.kassa.test",
      outletId: null,
      fetchImpl,
      clock,
      isOnline: () => true,
    });

    expect(result.tables.find((t) => t.table === "stock_snapshot")?.skipped).toBe(true);
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
        (c[0] as string).includes("/v1/stock/snapshot"),
      ),
    ).toBeUndefined();
  });

  it("follows pagination via nextPageToken, holds cursor until last page", async () => {
    const state = { page: 0 };
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/outlets") {
        state.page += 1;
        if (state.page === 1) {
          expect(parsed.searchParams.has("pageToken")).toBe(false);
          return jsonResponse({
            records: outletBody().records,
            nextCursor: "2026-04-24T01:00:00Z",
            nextPageToken: "tok-2",
          });
        }
        expect(parsed.searchParams.get("pageToken")).toBe("tok-2");
        return jsonResponse(emptyPageBody());
      }
      return jsonResponse(defaultBodyFor(parsed.pathname));
    }) as unknown as typeof fetch;

    const result = await pullAll(database, {
      baseUrl: "https://api.kassa.test",
      outletId: OUTLET_ID,
      fetchImpl,
      clock,
      isOnline: () => true,
    });

    const outletResult = result.tables.find((t) => t.table === "outlets");
    expect(outletResult?.batches).toBe(2);
    expect(outletResult?.cursor).toBe(null);
  });
});
