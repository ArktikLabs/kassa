import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { InMemoryItemsRepository, ItemsService } from "../src/services/catalog/index.js";
import { uuidv7 } from "../src/lib/uuid.js";

const STAFF_TOKEN = "test-staff-token-1234567890abcdef";
const MERCHANT_A = "01890abc-1234-7def-8000-00000000aaa1";
const MERCHANT_B = "01890abc-1234-7def-8000-00000000aaa2";
const STAFF_USER = "01890abc-1234-7def-8000-000000000020";
const UOM_A = "01890abc-1234-7def-8000-0000000c0001";
const UOM_MISSING = "01890abc-1234-7def-8000-0000000c0099";
const BOM_A = "01890abc-1234-7def-8000-0000000b0001";
const BOM_MISSING = "01890abc-1234-7def-8000-0000000b0099";

// `uuidv7` lives in services/enrolment; the helper is fine for deterministic
// ids here but we just hand-roll stable v7 hex for deterministic assertions.
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
  repo.seedBom(MERCHANT_A, BOM_A);
  // Merchant B has nothing seeded — used to prove tenant isolation.

  const now = { value: new Date("2026-04-24T00:00:00Z") };
  const nextId = { value: 0x1000 };
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

function headers(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${STAFF_TOKEN}`,
    "x-staff-user-id": STAFF_USER,
    "x-staff-merchant-id": MERCHANT_A,
    "content-type": "application/json",
    ...overrides,
  };
}

// DELETE has no body; sending `content-type: application/json` would trip
// Fastify's empty-JSON-body guard with a 400. Real clients (curl, fetch)
// don't set content-type without a payload either.
function noBodyHeaders(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  const h = headers(overrides);
  delete h["content-type"];
  return h;
}

interface ItemBody {
  id: string;
  code: string;
  name: string;
  priceIdr: number;
  uomId: string;
  bomId: string | null;
  isStockTracked: boolean;
  isActive: boolean;
  updatedAt: string;
}

describe("/v1/catalog/items — auth gating", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.app.close();
  });

  it("401s when no bearer is present", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/catalog/items" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: "unauthorized", message: "Staff bootstrap token required." },
    });
  });

  it("401s when the bearer is wrong", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/items",
      headers: { authorization: "Bearer nope-nope-nope-nope-nope!" },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("400s when X-Staff-User-Id is missing", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/items",
      headers: {
        authorization: `Bearer ${STAFF_TOKEN}`,
        "x-staff-merchant-id": MERCHANT_A,
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("400s when X-Staff-Merchant-Id is missing", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/items",
      headers: {
        authorization: `Bearer ${STAFF_TOKEN}`,
        "x-staff-user-id": STAFF_USER,
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("503s when the server boots without STAFF_BOOTSTRAP_TOKEN", async () => {
    const app = await buildApp({
      catalog: { items: new ItemsService({ repository: new InMemoryItemsRepository() }) },
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/v1/catalog/items" });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "staff_bootstrap_disabled",
      );
    } finally {
      await app.close();
    }
  });
});

describe("POST /v1/catalog/items", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h?.app.close();
  });

  it("creates with 201 and echoes the stored row", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: {
        code: "ESP-001",
        name: "Espresso single",
        priceIdr: 18000,
        uomId: UOM_A,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as ItemBody;
    expect(body).toMatchObject({
      code: "ESP-001",
      name: "Espresso single",
      priceIdr: 18000,
      uomId: UOM_A,
      bomId: null,
      isStockTracked: true,
      isActive: true,
    });
    expect(body.id).toMatch(/^01890abc-/);
    expect(() => new Date(body.updatedAt).toISOString()).not.toThrow();
  });

  it("accepts bomId + isStockTracked=false (menu item with recipe)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: {
        code: "MENU-1",
        name: "Latte",
        priceIdr: 28000,
        uomId: UOM_A,
        bomId: BOM_A,
        isStockTracked: false,
      },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as ItemBody).bomId).toBe(BOM_A);
    expect((res.json() as ItemBody).isStockTracked).toBe(false);
  });

  it("422s invalid body and includes a flatten-style details payload", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: { code: "", name: "bad", priceIdr: -5, uomId: "not-a-uuid" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as {
      error: { code: string; message: string; details: unknown };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details).toBeDefined();
  });

  it("422s a strict-schema violation (unknown field)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: {
        code: "ABC",
        name: "x",
        priceIdr: 1,
        uomId: UOM_A,
        extra: "nope",
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("404s when uomId does not belong to the merchant", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: { code: "X", name: "x", priceIdr: 1, uomId: UOM_MISSING },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("uom_not_found");
  });

  it("404s when bomId does not belong to the merchant", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: { code: "X", name: "x", priceIdr: 1, uomId: UOM_A, bomId: BOM_MISSING },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("bom_not_found");
  });

  it("409s on duplicate (merchantId, code)", async () => {
    await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: { code: "DUP", name: "a", priceIdr: 1, uomId: UOM_A },
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: { code: "DUP", name: "b", priceIdr: 2, uomId: UOM_A },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("item_code_conflict");
  });

  it("does NOT 409 when same code is used under a different merchant", async () => {
    await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: { code: "SAME", name: "a", priceIdr: 1, uomId: UOM_A },
    });
    h.repo.seedUom(MERCHANT_B, UOM_A); // merchant B has its own uom id reuse
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers({ "x-staff-merchant-id": MERCHANT_B }),
      payload: { code: "SAME", name: "b", priceIdr: 2, uomId: UOM_A },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("GET /v1/catalog/items/:itemId", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.app.close();
  });

  it("returns 200 for an existing item", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: { code: "GET-1", name: "a", priceIdr: 100, uomId: UOM_A },
    });
    const createdBody = created.json() as ItemBody;
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/catalog/items/${createdBody.id}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(createdBody);
  });

  it("404s an unknown id", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/catalog/items/${uuidv7()}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("item_not_found");
  });

  it("404s a non-UUID path param without leaking the value unsanitised", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/items/not-a-uuid",
      headers: headers(),
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("item_not_found");
  });

  it("404s when the item belongs to a different merchant (tenant isolation)", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: { code: "OTHER-1", name: "a", priceIdr: 100, uomId: UOM_A },
    });
    const id = (created.json() as ItemBody).id;
    h.repo.seedUom(MERCHANT_B, UOM_A);
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/catalog/items/${id}`,
      headers: headers({ "x-staff-merchant-id": MERCHANT_B }),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /v1/catalog/items/:itemId", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h?.app.close();
  });

  async function createItem(code = "P-1", extra: object = {}): Promise<ItemBody> {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: { code, name: "a", priceIdr: 100, uomId: UOM_A, ...extra },
    });
    return res.json() as ItemBody;
  }

  it("updates a subset and bumps updatedAt", async () => {
    const created = await createItem();
    h.now.value = new Date("2026-04-24T01:00:00Z");
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/catalog/items/${created.id}`,
      headers: headers(),
      payload: { priceIdr: 999, name: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ItemBody;
    expect(body.priceIdr).toBe(999);
    expect(body.name).toBe("Renamed");
    expect(body.updatedAt).toBe("2026-04-24T01:00:00.000Z");
  });

  it("422s an empty body", async () => {
    const created = await createItem();
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/catalog/items/${created.id}`,
      headers: headers(),
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("404s an unknown id", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/catalog/items/${uuidv7()}`,
      headers: headers(),
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s when renaming to a code that already exists for the merchant", async () => {
    await createItem("A");
    const other = await createItem("B");
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/catalog/items/${other.id}`,
      headers: headers(),
      payload: { code: "A" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("404s when patch references an unknown uomId", async () => {
    const created = await createItem();
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/catalog/items/${created.id}`,
      headers: headers(),
      payload: { uomId: UOM_MISSING },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("uom_not_found");
  });

  it("allows nulling bomId", async () => {
    const created = await createItem("WBOM", { bomId: BOM_A });
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/catalog/items/${created.id}`,
      headers: headers(),
      payload: { bomId: null },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ItemBody).bomId).toBeNull();
  });
});

describe("DELETE /v1/catalog/items/:itemId", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h?.app.close();
  });

  it("soft-deletes, returns 204, and subsequent GET shows isActive=false", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: headers(),
      payload: { code: "DEL-1", name: "a", priceIdr: 1, uomId: UOM_A },
    });
    const id = (created.json() as ItemBody).id;
    const del = await h.app.inject({
      method: "DELETE",
      url: `/v1/catalog/items/${id}`,
      headers: noBodyHeaders(),
    });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");
    const get = await h.app.inject({
      method: "GET",
      url: `/v1/catalog/items/${id}`,
      headers: headers(),
    });
    expect(get.statusCode).toBe(200);
    expect((get.json() as ItemBody).isActive).toBe(false);
  });

  it("404s an unknown id", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: `/v1/catalog/items/${uuidv7()}`,
      headers: noBodyHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /v1/catalog/items — pagination", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
    // Seed 5 items across increasing updatedAt values.
    for (let i = 0; i < 5; i++) {
      h.now.value = new Date(`2026-04-24T00:0${i}:00Z`);
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/catalog/items",
        headers: headers(),
        payload: { code: `PAG-${i}`, name: `n${i}`, priceIdr: i, uomId: UOM_A },
      });
      if (res.statusCode !== 201) throw new Error(`seed ${i} failed: ${res.body}`);
    }
  });
  afterAll(async () => {
    await h.app.close();
  });

  it("returns every row when no limit is set (default page >= 5)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/items",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      records: ItemBody[];
      nextCursor: string | null;
      nextPageToken: string | null;
    };
    expect(body.records).toHaveLength(5);
    expect(body.nextPageToken).toBeNull();
    expect(body.nextCursor).toBe("2026-04-24T00:04:00.000Z");
    const codes = body.records.map((r) => r.code);
    expect(codes).toEqual(["PAG-0", "PAG-1", "PAG-2", "PAG-3", "PAG-4"]);
  });

  it("limits and hands back a page token that walks the rest of the set", async () => {
    const first = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/items?limit=2",
      headers: headers(),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      records: ItemBody[];
      nextPageToken: string | null;
      nextCursor: string | null;
    };
    expect(firstBody.records.map((r) => r.code)).toEqual(["PAG-0", "PAG-1"]);
    expect(firstBody.nextPageToken).toBeTruthy();
    expect(firstBody.nextCursor).toBeNull();

    const second = await h.app.inject({
      method: "GET",
      url: `/v1/catalog/items?limit=2&pageToken=${encodeURIComponent(firstBody.nextPageToken ?? "")}`,
      headers: headers(),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { records: ItemBody[]; nextPageToken: string | null };
    expect(secondBody.records.map((r) => r.code)).toEqual(["PAG-2", "PAG-3"]);
    expect(secondBody.nextPageToken).toBeTruthy();

    const third = await h.app.inject({
      method: "GET",
      url: `/v1/catalog/items?limit=2&pageToken=${encodeURIComponent(secondBody.nextPageToken ?? "")}`,
      headers: headers(),
    });
    expect(third.statusCode).toBe(200);
    const thirdBody = third.json() as {
      records: ItemBody[];
      nextPageToken: string | null;
      nextCursor: string | null;
    };
    expect(thirdBody.records.map((r) => r.code)).toEqual(["PAG-4"]);
    expect(thirdBody.nextPageToken).toBeNull();
    expect(thirdBody.nextCursor).toBe("2026-04-24T00:04:00.000Z");
  });

  it("filters by updatedAfter (delta pull)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/catalog/items?updatedAfter=${encodeURIComponent("2026-04-24T00:02:00.000Z")}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { records: ItemBody[] };
    expect(body.records.map((r) => r.code)).toEqual(["PAG-3", "PAG-4"]);
  });

  it("400s an invalid limit", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/items?limit=9999",
      headers: headers(),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("bad_request");
  });
});
