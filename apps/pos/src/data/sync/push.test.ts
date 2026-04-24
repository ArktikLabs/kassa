import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { toRupiah } from "../../shared/money/index.ts";
import { createRepos, type Database } from "../db/index.ts";
import { DB_NAME, openKassaDb } from "../db/schema.ts";
import type { NewPendingSale } from "../db/pending-sales.ts";
import { SALES_SUBMIT_PATH, pushOutbox } from "./push.ts";
import { createSyncStatusStore } from "./status.ts";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function freshDatabase(): Promise<Database & { name: string }> {
  const name = `${DB_NAME}-push-${Math.random().toString(36).slice(2)}`;
  await Dexie.delete(name);
  const db = await openKassaDb(name);
  return {
    name,
    db,
    repos: createRepos(db),
    close: () => db.close(),
  };
}

function makeSale(overrides: Partial<NewPendingSale> = {}): NewPendingSale {
  return {
    localSaleId: overrides.localSaleId ?? "01940000-0000-7000-8000-000000000001",
    outletId: overrides.outletId ?? "01940000-0000-7000-8000-00000000aaaa",
    clerkId: overrides.clerkId ?? "device-1",
    businessDate: overrides.businessDate ?? "2026-04-24",
    createdAt: overrides.createdAt ?? "2026-04-24T09:00:00.000Z",
    subtotalIdr: overrides.subtotalIdr ?? toRupiah(50_000),
    discountIdr: overrides.discountIdr ?? toRupiah(0),
    totalIdr: overrides.totalIdr ?? toRupiah(50_000),
    items: overrides.items ?? [],
    tenders: overrides.tenders ?? [],
  };
}

describe("pushOutbox", () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>;

  beforeEach(async () => {
    database = await freshDatabase();
  });

  afterEach(async () => {
    database.close();
    await Dexie.delete(database.name);
  });

  it("200 happy path — POSTs /v1/sales/submit and marks the row synced with the server name", async () => {
    await database.repos.pendingSales.enqueue(makeSale());
    const fetchImpl = vi.fn(async (_url: unknown, _init?: unknown) =>
      jsonResponse({ name: "SALE-00001", localSaleId: "ignored" }, 201),
    );

    const result = await pushOutbox(database, {
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
    expect(calledUrl).toBe(`https://api.kassa.test${SALES_SUBMIT_PATH}`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as { localSaleId: string };
    expect(body.localSaleId).toBe("01940000-0000-7000-8000-000000000001");
    const row = await database.repos.pendingSales.getById("01940000-0000-7000-8000-000000000001");
    expect(row?.status).toBe("synced");
    expect(row?.serverSaleName).toBe("SALE-00001");
  });

  it("409 idempotency — treats conflict as success and captures the server name", async () => {
    await database.repos.pendingSales.enqueue(makeSale());
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          name: "SALE-99999",
          message: "already recorded",
          localSaleId: "01940000-0000-7000-8000-000000000001",
        },
        409,
      ),
    ) as unknown as typeof fetch;

    const result = await pushOutbox(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl,
    });

    expect(result.synced).toBe(1);
    expect(result.errored).toBe(0);
    expect(result.stoppedBy).toBe("completed");
    const row = await database.repos.pendingSales.getById("01940000-0000-7000-8000-000000000001");
    expect(row?.status).toBe("synced");
    expect(row?.serverSaleName).toBe("SALE-99999");
  });

  it("500 retry — marks the row error, halts the drain, and leaves later rows queued", async () => {
    await database.repos.pendingSales.enqueue(
      makeSale({
        localSaleId: "01940000-0000-7000-8000-000000000002",
        createdAt: "2026-04-24T09:00:00.000Z",
      }),
    );
    await database.repos.pendingSales.enqueue(
      makeSale({
        localSaleId: "01940000-0000-7000-8000-000000000003",
        createdAt: "2026-04-24T09:01:00.000Z",
      }),
    );

    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "upstream down" }, 503),
    ) as unknown as typeof fetch;

    const result = await pushOutbox(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl,
    });

    expect(result).toMatchObject({
      attempted: 1,
      synced: 0,
      needsAttention: 0,
      errored: 1,
      stoppedBy: "retriable",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const first = await database.repos.pendingSales.getById("01940000-0000-7000-8000-000000000002");
    expect(first?.status).toBe("error");
    expect(first?.attempts).toBe(1);
    expect(first?.lastError).toContain("upstream down");

    const second = await database.repos.pendingSales.getById(
      "01940000-0000-7000-8000-000000000003",
    );
    // Second row never got a POST — it stays queued for the next drain cycle.
    expect(second?.status).toBe("queued");
    expect(second?.attempts).toBe(0);
  });

  it("422 needs-attention — parks the row but keeps draining the rest of the batch", async () => {
    await database.repos.pendingSales.enqueue(
      makeSale({
        localSaleId: "01940000-0000-7000-8000-000000000004",
        createdAt: "2026-04-24T09:00:00.000Z",
      }),
    );
    await database.repos.pendingSales.enqueue(
      makeSale({
        localSaleId: "01940000-0000-7000-8000-000000000005",
        createdAt: "2026-04-24T09:01:00.000Z",
      }),
    );

    const responses: Array<() => Response> = [
      () => jsonResponse({ message: "total mismatch" }, 422),
      () => jsonResponse({ name: "SALE-00002" }, 200),
    ];
    const fetchImpl = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra call");
      return next();
    }) as unknown as typeof fetch;

    const result = await pushOutbox(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl,
    });

    expect(result).toMatchObject({
      attempted: 2,
      synced: 1,
      needsAttention: 1,
      errored: 0,
      stoppedBy: "completed",
    });

    const bad = await database.repos.pendingSales.getById("01940000-0000-7000-8000-000000000004");
    expect(bad?.status).toBe("needs_attention");
    expect(bad?.lastError).toContain("total mismatch");

    const good = await database.repos.pendingSales.getById("01940000-0000-7000-8000-000000000005");
    expect(good?.status).toBe("synced");
    expect(good?.serverSaleName).toBe("SALE-00002");
  });

  it("resets in-flight rows on drain entry so a tab death does not orphan them", async () => {
    // Simulate the prior tab: an enqueue moved to `sending` and never
    // completed because the tab was closed.
    await database.repos.pendingSales.enqueue(
      makeSale({
        localSaleId: "01940000-0000-7000-8000-000000000006",
      }),
    );
    await database.repos.pendingSales.markSending(
      "01940000-0000-7000-8000-000000000006",
      "2026-04-24T08:00:00.000Z",
    );
    const stuck = await database.repos.pendingSales.getById("01940000-0000-7000-8000-000000000006");
    expect(stuck?.status).toBe("sending");

    const fetchImpl = vi.fn(async () =>
      jsonResponse({ name: "SALE-RECOVERED" }, 201),
    ) as unknown as typeof fetch;
    const result = await pushOutbox(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl,
    });
    expect(result.synced).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const recovered = await database.repos.pendingSales.getById(
      "01940000-0000-7000-8000-000000000006",
    );
    expect(recovered?.status).toBe("synced");
    expect(recovered?.serverSaleName).toBe("SALE-RECOVERED");
  });

  it("offline — returns without touching the outbox", async () => {
    await database.repos.pendingSales.enqueue(makeSale());
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const result = await pushOutbox(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl,
      isOnline: () => false,
    });

    expect(result.stoppedBy).toBe("offline");
    expect(fetchImpl).not.toHaveBeenCalled();
    const row = await database.repos.pendingSales.getById("01940000-0000-7000-8000-000000000001");
    expect(row?.status).toBe("queued");
  });

  it("network error — marks the row error and halts the drain", async () => {
    await database.repos.pendingSales.enqueue(makeSale());
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("failed to fetch");
    }) as unknown as typeof fetch;

    const result = await pushOutbox(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl,
    });

    expect(result.stoppedBy).toBe("retriable");
    expect(result.errored).toBe(1);
    const row = await database.repos.pendingSales.getById("01940000-0000-7000-8000-000000000001");
    expect(row?.status).toBe("error");
    expect(row?.lastError).toContain("network");
  });

  it("attaches auth headers when credentials are provided", async () => {
    await database.repos.pendingSales.enqueue(makeSale());
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "SALE-AUTH" }, 201));

    await pushOutbox(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      auth: { apiKey: "pk_live_1", apiSecret: "secret" },
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-kassa-api-key"]).toBe("pk_live_1");
    expect(headers["x-kassa-api-secret"]).toBe("secret");
    expect(headers["x-kassa-local-sale-id"]).toBe("01940000-0000-7000-8000-000000000001");
  });

  it("pushes the status phase into syncing with the outbox depth while draining", async () => {
    const status = createSyncStatusStore();
    await database.repos.pendingSales.enqueue(
      makeSale({ localSaleId: "01940000-0000-7000-8000-000000000007" }),
    );
    await database.repos.pendingSales.enqueue(
      makeSale({
        localSaleId: "01940000-0000-7000-8000-000000000008",
        createdAt: "2026-04-24T09:02:00.000Z",
      }),
    );

    const observed: Array<number> = [];
    const unsub = status.subscribe((s) => {
      if (s.phase.kind === "syncing" && s.phase.table === "pending_sales") {
        observed.push(s.phase.pending);
      }
    });

    const fetchImpl = vi.fn(async () =>
      jsonResponse({ name: "SALE-OK" }, 201),
    ) as unknown as typeof fetch;
    await pushOutbox(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl,
      status,
    });
    unsub();

    // First observation captures the initial drain depth (2), later
    // observations decrement as rows are synced.
    expect(observed[0]).toBe(2);
    expect(observed.at(-1)).toBe(0);
  });

  it("transitions the phase back to idle after a non-empty drain completes", async () => {
    const status = createSyncStatusStore();
    await database.repos.pendingSales.enqueue(
      makeSale({ localSaleId: "01940000-0000-7000-8000-000000000009" }),
    );
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ name: "SALE-IDLE" }, 201),
    ) as unknown as typeof fetch;
    const finishedAt = "2026-04-24T09:05:00.000Z";

    await pushOutbox(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl,
      status,
      clock: () => new Date(finishedAt),
    });

    expect(status.get().phase).toEqual({
      kind: "idle",
      lastSuccessAt: finishedAt,
      lastError: null,
    });
  });

  it("empty outbox — returns completed without calling fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await pushOutbox(database, {
      baseUrl: "https://api.kassa.test",
      fetchImpl,
    });
    expect(result.stoppedBy).toBe("completed");
    expect(result.attempted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
