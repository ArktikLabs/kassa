import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepos, type Database } from "../db/index.ts";
import { DB_NAME, openKassaDb } from "../db/schema.ts";
import type { NewPendingVoid } from "../db/pending-voids.ts";
import type { PendingVoid } from "../db/types.ts";
import { pushVoids, SALES_VOID_PATH } from "./push-voids.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function freshDatabase(): Promise<Database & { name: string }> {
  const name = `${DB_NAME}-pushvoids-${Math.random().toString(36).slice(2)}`;
  await Dexie.delete(name);
  const db = await openKassaDb(name);
  return {
    name,
    db,
    repos: createRepos(db),
    close: () => db.close(),
  };
}

function makeVoid(overrides: Partial<NewPendingVoid> & { localVoidId: string }): NewPendingVoid {
  return {
    localVoidId: overrides.localVoidId,
    saleId: overrides.saleId ?? "sale-server-id",
    localSaleId: overrides.localSaleId ?? "sale-local-id",
    outletId: overrides.outletId ?? "outlet-a",
    managerStaffId: overrides.managerStaffId ?? "staff-mgr-1",
    managerPin: overrides.managerPin ?? "1234",
    voidedAt: overrides.voidedAt ?? "2026-05-12T09:30:00.000Z",
    voidBusinessDate: overrides.voidBusinessDate ?? "2026-05-12",
    reason: overrides.reason ?? null,
    createdAt: overrides.createdAt ?? "2026-05-12T09:30:00.000Z",
  };
}

const auth = { apiKey: "k", apiSecret: "s" };
const clock = () => new Date("2026-05-12T10:00:00.000Z");

describe("pushVoids", () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>;

  beforeEach(async () => {
    database = await freshDatabase();
  });

  afterEach(async () => {
    database.close();
    await Dexie.delete(database.name);
  });

  it("returns offline-completed without touching the network when isOnline=false", async () => {
    await database.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await pushVoids(database, {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
      isOnline: () => false,
      clock,
    });
    expect(res.stoppedBy).toBe("offline");
    expect(res.attempted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns completed without touching the network when the outbox is empty", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await pushVoids(database, {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
      isOnline: () => true,
      clock,
    });
    expect(res).toMatchObject({
      attempted: 0,
      synced: 0,
      needsAttention: 0,
      errored: 0,
      stoppedBy: "completed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("200 happy path → marks row synced, fires onVoidSynced, posts to /v1/sales/:id/void with auth headers", async () => {
    await database.repos.pendingVoids.enqueue(
      makeVoid({ localVoidId: "v1", saleId: "sale-xyz", reason: "salah" }),
    );
    const synced: PendingVoid[] = [];
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => jsonResponse({}, 200));

    const res = await pushVoids(database, {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl: fetchMock as unknown as typeof fetch,
      isOnline: () => true,
      clock,
      onVoidSynced: async (row) => {
        synced.push(row);
      },
    });

    expect(res).toMatchObject({ attempted: 1, synced: 1, stoppedBy: "completed" });
    const row = await database.repos.pendingVoids.getById("v1");
    expect(row?.status).toBe("synced");
    expect(row?.lastAttemptAt).toBe("2026-05-12T10:00:00.000Z");
    expect(synced).toHaveLength(1);
    expect(synced[0]?.localVoidId).toBe("v1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(`https://api.kassa.test${SALES_VOID_PATH("sale-xyz")}`);
    const headers = init.headers as Record<string, string>;
    expect(headers["x-kassa-api-key"]).toBe("k");
    expect(headers["x-kassa-api-secret"]).toBe("s");
    const body = JSON.parse(String(init.body!));
    expect(body).toEqual({
      localVoidId: "v1",
      managerStaffId: "staff-mgr-1",
      managerPin: "1234",
      voidedAt: "2026-05-12T09:30:00.000Z",
      voidBusinessDate: "2026-05-12",
      reason: "salah",
    });
  });

  it("403 → needs_attention (terminal); does NOT fire onVoidSynced", async () => {
    await database.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    const synced = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "manager_pin_required", message: "wrong" } }, 403),
    ) as unknown as typeof fetch;

    const res = await pushVoids(database, {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
      isOnline: () => true,
      clock,
      onVoidSynced: synced,
    });

    expect(res).toMatchObject({
      attempted: 1,
      needsAttention: 1,
      synced: 0,
      stoppedBy: "completed",
    });
    const row = await database.repos.pendingVoids.getById("v1");
    expect(row?.status).toBe("needs_attention");
    expect(row?.lastError).toContain("wrong");
    expect(synced).not.toHaveBeenCalled();
  });

  it("422 → needs_attention (terminal)", async () => {
    await database.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "void_outside_open_shift", message: "shift" } }, 422),
    ) as unknown as typeof fetch;
    const res = await pushVoids(database, {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
      isOnline: () => true,
      clock,
    });
    expect(res.needsAttention).toBe(1);
    const row = await database.repos.pendingVoids.getById("v1");
    expect(row?.status).toBe("needs_attention");
  });

  it("409 idempotency conflict → needs_attention (terminal)", async () => {
    await database.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "void_idempotency_conflict", message: "dup" } }, 409),
    ) as unknown as typeof fetch;
    const res = await pushVoids(database, {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
      isOnline: () => true,
      clock,
    });
    expect(res.needsAttention).toBe(1);
    const row = await database.repos.pendingVoids.getById("v1");
    expect(row?.status).toBe("needs_attention");
  });

  it.each([408, 429, 500, 503])("%d → error and stops the drain (retriable)", async (status) => {
    await database.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    await database.repos.pendingVoids.enqueue(
      makeVoid({ localVoidId: "v2", createdAt: "2026-05-12T09:31:00.000Z" }),
    );
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
    const res = await pushVoids(database, {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
      isOnline: () => true,
      clock,
    });
    expect(res.stoppedBy).toBe("retriable");
    expect(res.attempted).toBe(1);
    expect(res.errored).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const v1 = await database.repos.pendingVoids.getById("v1");
    expect(v1?.status).toBe("error");
    const v2 = await database.repos.pendingVoids.getById("v2");
    // Still queued — drain bailed before reaching it.
    expect(v2?.status).toBe("queued");
  });

  it("network error → error and stops the drain (retriable)", async () => {
    await database.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const res = await pushVoids(database, {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
      isOnline: () => true,
      clock,
    });
    expect(res.stoppedBy).toBe("retriable");
    const row = await database.repos.pendingVoids.getById("v1");
    expect(row?.status).toBe("error");
    expect(row?.lastError).toContain("fetch failed");
  });

  it("resets stuck `sending` rows back to queued before draining", async () => {
    // Simulate a previous tab death leaving v1 in `sending`. resetInFlight
    // should flip it back to queued so this drain retakes it.
    await database.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    await database.repos.pendingVoids.markSending("v1", "2026-05-12T09:00:00.000Z");
    const fetchImpl = vi.fn(async () => jsonResponse({}, 200)) as unknown as typeof fetch;

    const res = await pushVoids(database, {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
      isOnline: () => true,
      clock,
    });

    expect(res).toMatchObject({ attempted: 1, synced: 1 });
  });

  it("drains in createdAt order so older voids land first", async () => {
    await database.repos.pendingVoids.enqueue(
      makeVoid({ localVoidId: "v-newer", createdAt: "2026-05-12T09:35:00.000Z" }),
    );
    await database.repos.pendingVoids.enqueue(
      makeVoid({ localVoidId: "v-older", createdAt: "2026-05-12T09:30:00.000Z" }),
    );
    const callOrder: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body));
      callOrder.push(body.localVoidId);
      return jsonResponse({}, 200);
    }) as unknown as typeof fetch;

    await pushVoids(database, {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
      isOnline: () => true,
      clock,
    });
    expect(callOrder).toEqual(["v-older", "v-newer"]);
  });

  it("aborted signal stops the drain partway through", async () => {
    await database.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    await database.repos.pendingVoids.enqueue(
      makeVoid({ localVoidId: "v2", createdAt: "2026-05-12T09:31:00.000Z" }),
    );
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      return jsonResponse({}, 200);
    }) as unknown as typeof fetch;

    const res = await pushVoids(database, {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
      isOnline: () => true,
      clock,
      signal: controller.signal,
    });
    expect(res.stoppedBy).toBe("aborted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
