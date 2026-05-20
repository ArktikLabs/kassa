import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { InMemoryItemsRepository, ItemsService } from "../src/services/catalog/index.js";

const STAFF_TOKEN = "test-staff-token-1234567890abcdef";
const MERCHANT_A = "01890abc-1234-7def-8000-00000000aaa1";
const STAFF_USER = "01890abc-1234-7def-8000-000000000020";
const UOM_A = "01890abc-1234-7def-8000-0000000c0001";
const UOM_MISSING = "01890abc-1234-7def-8000-0000000c0099";

function seededUuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `01890abc-1234-7def-8000-${hex}`;
}

interface Harness {
  app: FastifyInstance;
  repo: InMemoryItemsRepository;
  service: ItemsService;
  now: { value: Date };
  nextId: { value: number };
}

async function setup(): Promise<Harness> {
  const repo = new InMemoryItemsRepository();
  repo.seedUom(MERCHANT_A, UOM_A);
  const now = { value: new Date("2026-05-20T04:00:00Z") };
  const nextId = { value: 0x2000 };
  const service = new ItemsService({
    repository: repo,
    now: () => now.value,
    generateId: () => {
      nextId.value += 1;
      return seededUuid(nextId.value);
    },
  });
  const app = await buildApp({
    catalog: { items: service, staffBootstrapToken: STAFF_TOKEN },
  });
  await app.ready();
  return { app, repo, service, now, nextId };
}

function headers(role: string = "owner"): Record<string, string> {
  return {
    authorization: `Bearer ${STAFF_TOKEN}`,
    "x-staff-user-id": STAFF_USER,
    "x-staff-merchant-id": MERCHANT_A,
    "x-staff-role": role,
    "content-type": "application/json",
  };
}

interface BulkResult {
  results: Array<{
    code: string;
    status: "created" | "updated" | "unchanged";
    item: { id: string; code: string; name: string; priceIdr: number; updatedAt: string };
  }>;
  summary: { created: number; updated: number; unchanged: number };
}

describe("POST /v1/catalog/items/bulk (KASA-311)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h?.app.close();
  });

  it("creates new items in a single transaction and reports the summary", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items/bulk",
      headers: headers(),
      payload: {
        items: [
          { code: "NSI-001", name: "Nasi Ayam", priceIdr: 25000, uomId: UOM_A },
          { code: "KOP-001", name: "Kopi Susu", priceIdr: 18000, uomId: UOM_A },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BulkResult;
    expect(body.summary).toEqual({ created: 2, updated: 0, unchanged: 0 });
    expect(body.results.map((r) => r.status)).toEqual(["created", "created"]);
    expect(body.results[0]!.item.code).toBe("NSI-001");
  });

  it("flags `unchanged` when re-importing an identical row (idempotency)", async () => {
    // Round 1: create.
    await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items/bulk",
      headers: headers(),
      payload: { items: [{ code: "NSI-001", name: "Nasi Ayam", priceIdr: 25000, uomId: UOM_A }] },
    });
    // Advance the clock so any spurious write would be detectable.
    h.now.value = new Date("2026-05-20T05:00:00Z");

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items/bulk",
      headers: headers(),
      payload: { items: [{ code: "NSI-001", name: "Nasi Ayam", priceIdr: 25000, uomId: UOM_A }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BulkResult;
    expect(body.summary).toEqual({ created: 0, updated: 0, unchanged: 1 });
    expect(body.results[0]!.status).toBe("unchanged");
    // updatedAt must NOT have moved on the no-op re-import.
    expect(body.results[0]!.item.updatedAt).toBe("2026-05-20T04:00:00.000Z");
  });

  it("rolls back the entire batch when one row references a missing uom", async () => {
    const before = h.repo;
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items/bulk",
      headers: headers(),
      payload: {
        items: [
          { code: "OK-1", name: "Good row", priceIdr: 1000, uomId: UOM_A },
          { code: "BAD-1", name: "Bad row", priceIdr: 1000, uomId: UOM_MISSING },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string; details: { rowIndex: number } } };
    expect(body.error.code).toBe("uom_not_found");
    expect(body.error.details.rowIndex).toBe(1);

    // No row leaked into the repo.
    const listed = await before.listItems({ merchantId: MERCHANT_A, limit: 10 });
    expect(listed.records).toHaveLength(0);
  });

  it("rejects an over-cap batch with 422 (schema-level)", async () => {
    const items = Array.from({ length: 501 }, (_, i) => ({
      code: `B-${i.toString().padStart(4, "0")}`,
      name: "Bulk row",
      priceIdr: 1000,
      uomId: UOM_A,
    }));
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items/bulk",
      headers: headers(),
      payload: { items },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects duplicate codes within the batch at the schema layer", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items/bulk",
      headers: headers(),
      payload: {
        items: [
          { code: "DUP", name: "first", priceIdr: 1000, uomId: UOM_A },
          { code: "DUP", name: "second", priceIdr: 2000, uomId: UOM_A },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("403s a manager role — bulk is owner-only", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items/bulk",
      headers: headers("manager"),
      payload: { items: [{ code: "X", name: "x", priceIdr: 1, uomId: UOM_A }] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a cashier role", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items/bulk",
      headers: headers("cashier"),
      payload: { items: [{ code: "X", name: "x", priceIdr: 1, uomId: UOM_A }] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("updates only the rows whose persisted fields actually changed", async () => {
    await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items/bulk",
      headers: headers(),
      payload: {
        items: [
          { code: "A", name: "Item A", priceIdr: 1000, uomId: UOM_A },
          { code: "B", name: "Item B", priceIdr: 2000, uomId: UOM_A },
        ],
      },
    });
    h.now.value = new Date("2026-05-20T06:00:00Z");

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items/bulk",
      headers: headers(),
      payload: {
        items: [
          { code: "A", name: "Item A", priceIdr: 1000, uomId: UOM_A },
          { code: "B", name: "Item B v2", priceIdr: 2500, uomId: UOM_A },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BulkResult;
    expect(body.summary).toEqual({ created: 0, updated: 1, unchanged: 1 });
    const updated = body.results.find((r) => r.code === "B");
    expect(updated?.status).toBe("updated");
    expect(updated?.item.priceIdr).toBe(2500);
    expect(updated?.item.updatedAt).toBe("2026-05-20T06:00:00.000Z");
  });
});
