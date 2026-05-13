import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { createRepos, type Database } from "../db/index.ts";
import { DB_NAME, openKassaDb } from "../db/schema.ts";
import { pushCatalogMutations } from "./push-catalog.ts";

/*
 * KASA-248 — drain unit tests for the catalog availability outbox.
 *
 * The drain mirrors `push.ts` (pending-sales), so we re-use the same
 * shape of fixtures: fake-indexeddb for Dexie, hand-rolled fetch stubs
 * for the wire calls. Each test isolates a single status transition.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function freshDatabase(): Promise<Database & { name: string }> {
  const name = `${DB_NAME}-push-catalog-${Math.random().toString(36).slice(2)}`;
  await Dexie.delete(name);
  const db = await openKassaDb(name);
  return {
    name,
    db,
    repos: createRepos(db),
    close: () => db.close(),
  };
}

const ITEM_A = "01940000-0000-7000-8000-0000000aaaaa";
const ITEM_B = "01940000-0000-7000-8000-0000000bbbbb";

describe("pushCatalogMutations", () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>;

  beforeEach(async () => {
    database = await freshDatabase();
  });

  afterEach(async () => {
    database.close();
    await Dexie.delete(database.name);
  });

  it("200 happy path — PATCHes the item and removes the outbox row", async () => {
    await database.repos.pendingCatalogMutations.enqueue({
      itemId: ITEM_A,
      availability: "sold_out",
      createdAt: "2026-04-24T09:00:00.000Z",
    });
    const fetchImpl = vi.fn(async (_url: unknown, _init?: unknown) =>
      jsonResponse({ id: ITEM_A, availability: "sold_out" }, 200),
    );

    const result = await pushCatalogMutations(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      attempted: 1,
      synced: 1,
      needsAttention: 0,
      errored: 0,
      stoppedBy: "completed",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(`https://api.kassa.test/v1/catalog/items/${ITEM_A}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ availability: "sold_out" });

    await expect(database.repos.pendingCatalogMutations.listAll()).resolves.toHaveLength(0);
  });

  it("5xx is retriable — row stays in `error` and the drain halts", async () => {
    await database.repos.pendingCatalogMutations.enqueue({
      itemId: ITEM_A,
      availability: "sold_out",
      createdAt: "2026-04-24T09:00:00.000Z",
    });
    await database.repos.pendingCatalogMutations.enqueue({
      itemId: ITEM_B,
      availability: "sold_out",
      createdAt: "2026-04-24T09:01:00.000Z",
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: "boom" } }, 503));

    const result = await pushCatalogMutations(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      attempted: 1,
      synced: 0,
      errored: 1,
      stoppedBy: "retriable",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const rows = await database.repos.pendingCatalogMutations.listAll();
    // Both rows still queued/errored — the drain halts on the first
    // retriable failure so workbox can back off.
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.itemId === ITEM_A);
    expect(first?.status).toBe("error");
  });

  it("4xx terminal — row flips to `needs_attention` and the drain continues", async () => {
    await database.repos.pendingCatalogMutations.enqueue({
      itemId: ITEM_A,
      availability: "sold_out",
      createdAt: "2026-04-24T09:00:00.000Z",
    });
    await database.repos.pendingCatalogMutations.enqueue({
      itemId: ITEM_B,
      availability: "available",
      createdAt: "2026-04-24T09:01:00.000Z",
    });
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse({ error: { code: "validation_error" } }, 422);
      return jsonResponse({ id: ITEM_B, availability: "available" }, 200);
    });

    const result = await pushCatalogMutations(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      attempted: 2,
      synced: 1,
      needsAttention: 1,
      stoppedBy: "completed",
    });
    const rows = await database.repos.pendingCatalogMutations.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.itemId).toBe(ITEM_A);
    expect(rows[0]?.status).toBe("needs_attention");
  });

  it("offline short-circuits the drain without touching fetch", async () => {
    await database.repos.pendingCatalogMutations.enqueue({
      itemId: ITEM_A,
      availability: "sold_out",
      createdAt: "2026-04-24T09:00:00.000Z",
    });
    const fetchImpl = vi.fn();

    const result = await pushCatalogMutations(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      isOnline: () => false,
    });

    expect(result.stoppedBy).toBe("offline");
    expect(fetchImpl).not.toHaveBeenCalled();
    const rows = await database.repos.pendingCatalogMutations.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("queued");
  });

  it("collapses a flip-flop on the same itemId to the latest desired state", async () => {
    await database.repos.pendingCatalogMutations.enqueue({
      itemId: ITEM_A,
      availability: "sold_out",
      createdAt: "2026-04-24T09:00:00.000Z",
    });
    await database.repos.pendingCatalogMutations.enqueue({
      itemId: ITEM_A,
      availability: "available",
      createdAt: "2026-04-24T09:00:01.000Z",
    });

    const rows = await database.repos.pendingCatalogMutations.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.availability).toBe("available");
  });
});
