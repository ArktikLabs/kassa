import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { InMemoryOutletsRepository, OutletsService } from "../src/services/outlets/index.js";

const STAFF_TOKEN = "test-staff-token-1234567890abcdef";
const MERCHANT_A = "01890abc-1234-7def-8000-00000000aaa1";
const MERCHANT_B = "01890abc-1234-7def-8000-00000000aaa2";
const STAFF_USER = "01890abc-1234-7def-8000-000000000020";

function seededUuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `01890abc-1234-7def-8000-${hex}`;
}

interface Harness {
  app: FastifyInstance;
  repo: InMemoryOutletsRepository;
}

async function setup(): Promise<Harness> {
  const repo = new InMemoryOutletsRepository();
  const service = new OutletsService({ repository: repo });
  const app = await buildApp({
    outlets: { service, staffBootstrapToken: STAFF_TOKEN },
  });
  await app.ready();
  return { app, repo };
}

function headers(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${STAFF_TOKEN}`,
    "x-staff-user-id": STAFF_USER,
    "x-staff-merchant-id": MERCHANT_A,
    ...overrides,
  };
}

interface OutletBody {
  id: string;
  code: string;
  name: string;
  timezone: string;
  updatedAt: string;
}

interface PullEnvelope {
  records: OutletBody[];
  nextCursor: string | null;
  nextPageToken: string | null;
}

describe("/v1/outlets — auth gating", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.app.close();
  });

  it("401s when no bearer is present", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/outlets" });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("401s when the bearer is wrong", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/outlets",
      headers: { authorization: "Bearer nope-nope-nope-nope-nope!" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400s when X-Staff-Merchant-Id is missing", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/outlets",
      headers: {
        authorization: `Bearer ${STAFF_TOKEN}`,
        "x-staff-user-id": STAFF_USER,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("503s when the server boots without STAFF_BOOTSTRAP_TOKEN", async () => {
    const app = await buildApp();
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/v1/outlets" });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "staff_bootstrap_disabled",
      );
    } finally {
      await app.close();
    }
  });
});

describe("GET /v1/outlets — pull pagination + tenant isolation", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
    // 5 outlets for merchant A across increasing updatedAt; 1 outlet for merchant B
    // that must never appear in merchant A's pull.
    for (let i = 0; i < 5; i++) {
      h.repo.seedOutlet({
        id: seededUuid(0x1000 + i),
        merchantId: MERCHANT_A,
        code: `OUT-${i}`,
        name: `Outlet ${i}`,
        timezone: "Asia/Jakarta",
        createdAt: new Date(`2026-04-24T00:0${i}:00Z`),
        updatedAt: new Date(`2026-04-24T00:0${i}:00Z`),
      });
    }
    h.repo.seedOutlet({
      id: seededUuid(0x2000),
      merchantId: MERCHANT_B,
      code: "OTHER-1",
      name: "Other tenant",
      createdAt: new Date("2026-04-24T01:00:00Z"),
      updatedAt: new Date("2026-04-24T01:00:00Z"),
    });
  });
  afterAll(async () => {
    await h.app.close();
  });

  it("returns every merchant-A row in (updatedAt, id) order with no pageToken when default limit covers them", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/outlets",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PullEnvelope;
    expect(body.records).toHaveLength(5);
    expect(body.records.map((r) => r.code)).toEqual(["OUT-0", "OUT-1", "OUT-2", "OUT-3", "OUT-4"]);
    expect(body.nextPageToken).toBeNull();
    expect(body.nextCursor).toBe("2026-04-24T00:04:00.000Z");
  });

  it("paginates with limit + nextPageToken across the full set", async () => {
    const first = await h.app.inject({
      method: "GET",
      url: "/v1/outlets?limit=2",
      headers: headers(),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as PullEnvelope;
    expect(firstBody.records.map((r) => r.code)).toEqual(["OUT-0", "OUT-1"]);
    expect(firstBody.nextPageToken).toBeTruthy();
    expect(firstBody.nextCursor).toBeNull();

    const second = await h.app.inject({
      method: "GET",
      url: `/v1/outlets?limit=2&pageToken=${encodeURIComponent(firstBody.nextPageToken ?? "")}`,
      headers: headers(),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as PullEnvelope;
    expect(secondBody.records.map((r) => r.code)).toEqual(["OUT-2", "OUT-3"]);

    const third = await h.app.inject({
      method: "GET",
      url: `/v1/outlets?limit=2&pageToken=${encodeURIComponent(secondBody.nextPageToken ?? "")}`,
      headers: headers(),
    });
    expect(third.statusCode).toBe(200);
    const thirdBody = third.json() as PullEnvelope;
    expect(thirdBody.records.map((r) => r.code)).toEqual(["OUT-4"]);
    expect(thirdBody.nextPageToken).toBeNull();
    expect(thirdBody.nextCursor).toBe("2026-04-24T00:04:00.000Z");
  });

  it("filters by updatedAfter (delta pull)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/outlets?updatedAfter=${encodeURIComponent("2026-04-24T00:02:00.000Z")}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PullEnvelope;
    expect(body.records.map((r) => r.code)).toEqual(["OUT-3", "OUT-4"]);
  });

  it("returns an empty envelope when delta cursor is past the latest row", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/outlets?updatedAfter=${encodeURIComponent("2099-01-01T00:00:00.000Z")}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PullEnvelope;
    expect(body.records).toEqual([]);
    expect(body.nextPageToken).toBeNull();
    expect(body.nextCursor).toBeNull();
  });

  it("does NOT leak rows from another merchant", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/outlets",
      headers: headers({ "x-staff-merchant-id": MERCHANT_B }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PullEnvelope;
    expect(body.records).toHaveLength(1);
    expect(body.records[0]?.code).toBe("OTHER-1");
  });

  it("422s an invalid limit (over the cap)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/outlets?limit=9999",
      headers: headers(),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("422s an unknown query param (strict schema)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/outlets?nope=yes",
      headers: headers(),
    });
    expect(res.statusCode).toBe(422);
  });

  it("400s a malformed page token", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/outlets?pageToken=not-base64",
      headers: headers(),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("invalid_page_token");
  });
});

describe("GET /v1/outlets/:outletId", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.app.close();
  });

  it("still returns 501 (detail endpoint not in PR1 scope)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/outlets/${seededUuid(0x9999)}`,
    });
    expect(res.statusCode).toBe(501);
    expect((res.json() as { error: { code: string } }).error.code).toBe("not_implemented");
  });
});

describe("PATCH /v1/outlets/:outletId — receipt branding (KASA-367)", () => {
  let h: Harness;
  const OUTLET_A = seededUuid(0x3000);

  beforeAll(async () => {
    h = await setup();
    h.repo.seedOutlet({
      id: OUTLET_A,
      merchantId: MERCHANT_A,
      code: "WRG-01",
      name: "Warung Pusat",
      timezone: "Asia/Jakarta",
      createdAt: new Date("2026-04-24T00:00:00Z"),
      updatedAt: new Date("2026-04-24T00:00:00Z"),
    });
    h.repo.seedOutlet({
      id: seededUuid(0x3001),
      merchantId: MERCHANT_B,
      code: "OTHER-1",
      name: "Other tenant",
      createdAt: new Date("2026-04-24T00:00:00Z"),
      updatedAt: new Date("2026-04-24T00:00:00Z"),
    });
  });
  afterAll(async () => {
    await h.app.close();
  });

  const writeHeaders = (overrides: Partial<Record<string, string>> = {}): Record<string, string> =>
    headers({ "x-staff-role": "owner", ...overrides });

  it("403s when the staff role is not owner", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/outlets/${OUTLET_A}`,
      headers: writeHeaders({ "x-staff-role": "cashier" }),
      payload: { displayName: "Warung Pusat" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("422s on an empty PATCH body", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/outlets/${OUTLET_A}`,
      headers: writeHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("422s on a malformed NPWP", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/outlets/${OUTLET_A}`,
      headers: writeHeaders(),
      payload: { taxId: "01.234.567.8-901.000" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("422s on a footer line longer than 32 chars", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/outlets/${OUTLET_A}`,
      headers: writeHeaders(),
      payload: { receiptFooterLine1: "x".repeat(33) },
    });
    expect(res.statusCode).toBe(422);
  });

  it("404s for an outlet under a different tenant", async () => {
    const otherTenantOutlet = seededUuid(0x3001);
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/outlets/${otherTenantOutlet}`,
      headers: writeHeaders(),
      payload: { displayName: "tried to update" },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("outlet_not_found");
  });

  it("persists branding fields and bumps updatedAt", async () => {
    const before = await h.repo.findById({ merchantId: MERCHANT_A, outletId: OUTLET_A });
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/outlets/${OUTLET_A}`,
      headers: writeHeaders(),
      payload: {
        displayName: "Warung Pusat",
        addressLine1: "Jl. Sudirman No.1",
        taxId: "012345678901000",
        receiptFooterLine1: "Terima kasih",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      displayName: string;
      addressLine1: string;
      taxId: string;
      receiptFooterLine1: string;
      updatedAt: string;
    };
    expect(body.displayName).toBe("Warung Pusat");
    expect(body.taxId).toBe("012345678901000");
    expect(body.receiptFooterLine1).toBe("Terima kasih");
    expect(new Date(body.updatedAt).getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
  });

  it("clears a field when sent null", async () => {
    await h.app.inject({
      method: "PATCH",
      url: `/v1/outlets/${OUTLET_A}`,
      headers: writeHeaders(),
      payload: { displayName: "First" },
    });
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/outlets/${OUTLET_A}`,
      headers: writeHeaders(),
      payload: { displayName: null },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { displayName: string | null }).displayName).toBeNull();
  });
});
