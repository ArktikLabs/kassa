import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { InMemoryItemsRepository, ItemsService } from "../src/services/catalog/index.js";

/*
 * Wire-level coverage for KASA-26 role-based authorization on the catalog
 * write paths. The `allowedRoles` machinery itself is exercised end-to-end
 * by `reconciliation-routes.test.ts`; this suite proves catalog opted in
 * (writes restricted to owner|manager) and that reads still accept any role.
 */

const STAFF_TOKEN = "test-staff-token-1234567890abcdef";
const MERCHANT = "01890abc-1234-7def-8000-00000000aaa1";
const STAFF_USER = "01890abc-1234-7def-8000-000000000020";
const UOM = "01890abc-1234-7def-8000-0000000c0001";
const FAKE_ITEM = "01890abc-1234-7def-8000-0000000d0001";

interface Harness {
  app: FastifyInstance;
}

async function setup(): Promise<Harness> {
  const repo = new InMemoryItemsRepository();
  repo.seedUom(MERCHANT, UOM);
  const service = new ItemsService({ repository: repo });
  const app = await buildApp({
    catalog: { items: service, staffBootstrapToken: STAFF_TOKEN },
  });
  await app.ready();
  return { app };
}

interface StaffHeaderOverrides {
  role?: string;
  contentType?: string | null;
}

function staffHeaders(opts: StaffHeaderOverrides = {}): Record<string, string> {
  const out: Record<string, string> = {
    authorization: `Bearer ${STAFF_TOKEN}`,
    "x-staff-user-id": STAFF_USER,
    "x-staff-merchant-id": MERCHANT,
  };
  if (opts.role !== undefined) out["x-staff-role"] = opts.role;
  if (opts.contentType !== null) out["content-type"] = opts.contentType ?? "application/json";
  return out;
}

describe("catalog RBAC — write paths require owner/manager", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.app.close();
  });

  for (const role of ["cashier", "read_only"] as const) {
    it(`POST /v1/catalog/items → 403 for role=${role}`, async () => {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/catalog/items",
        headers: staffHeaders({ role }),
        payload: { code: "X1", name: "x", priceIdr: 1, uomId: UOM },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("forbidden");
    });

    it(`PATCH /v1/catalog/items/:itemId → 403 for role=${role}`, async () => {
      const res = await h.app.inject({
        method: "PATCH",
        url: `/v1/catalog/items/${FAKE_ITEM}`,
        headers: staffHeaders({ role }),
        payload: { name: "x" },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("forbidden");
    });

    it(`DELETE /v1/catalog/items/:itemId → 403 for role=${role}`, async () => {
      const res = await h.app.inject({
        method: "DELETE",
        url: `/v1/catalog/items/${FAKE_ITEM}`,
        headers: staffHeaders({ role, contentType: null }),
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("forbidden");
    });
  }

  it("POST /v1/catalog/items → 400 when X-Staff-Role is missing on a write", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: staffHeaders(),
      payload: { code: "Y1", name: "y", priceIdr: 1, uomId: UOM },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("POST /v1/catalog/items → 201 for role=owner", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: staffHeaders({ role: "owner" }),
      payload: { code: "OWN-1", name: "owner-item", priceIdr: 100, uomId: UOM },
    });
    expect(res.statusCode).toBe(201);
  });

  it("POST /v1/catalog/items → 201 for role=manager", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/catalog/items",
      headers: staffHeaders({ role: "manager" }),
      payload: { code: "MGR-1", name: "manager-item", priceIdr: 100, uomId: UOM },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("catalog RBAC — read paths accept any staff role", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.app.close();
  });

  for (const role of ["owner", "manager", "cashier", "read_only"] as const) {
    it(`GET /v1/catalog/items → 200 for role=${role}`, async () => {
      const res = await h.app.inject({
        method: "GET",
        url: "/v1/catalog/items",
        headers: staffHeaders({ role }),
      });
      expect(res.statusCode).toBe(200);
    });
  }

  it("GET /v1/catalog/items → 200 even without X-Staff-Role (reads stay open)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/items",
      headers: staffHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });
});
