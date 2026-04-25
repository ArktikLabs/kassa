import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  InMemoryItemsRepository,
  InMemoryUomsRepository,
  ItemsService,
  UomsService,
} from "../src/services/catalog/index.js";

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
  uomsRepo: InMemoryUomsRepository;
}

async function setup(): Promise<Harness> {
  const uomsRepo = new InMemoryUomsRepository();
  const uomsService = new UomsService({ repository: uomsRepo });
  const items = new ItemsService({ repository: new InMemoryItemsRepository() });
  const app = await buildApp({
    catalog: { items, uoms: uomsService, staffBootstrapToken: STAFF_TOKEN },
  });
  await app.ready();
  return { app, uomsRepo };
}

function headers(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${STAFF_TOKEN}`,
    "x-staff-user-id": STAFF_USER,
    "x-staff-merchant-id": MERCHANT_A,
    ...overrides,
  };
}

interface UomBody {
  id: string;
  code: string;
  name: string;
  updatedAt: string;
}

interface PullEnvelope {
  records: UomBody[];
  nextCursor: string | null;
  nextPageToken: string | null;
}

describe("/v1/catalog/uoms — auth gating", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.app.close();
  });

  it("401s when no bearer is present", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/catalog/uoms" });
    expect(res.statusCode).toBe(401);
  });

  it("400s when X-Staff-Merchant-Id is missing", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/uoms",
      headers: {
        authorization: `Bearer ${STAFF_TOKEN}`,
        "x-staff-user-id": STAFF_USER,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/catalog/uoms — pull pagination + tenant isolation", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
    const codes = ["pcs", "g", "ml", "cup", "btl"];
    for (let i = 0; i < codes.length; i++) {
      h.uomsRepo.seedUom({
        id: seededUuid(0xc000 + i),
        merchantId: MERCHANT_A,
        code: codes[i] ?? `c${i}`,
        name: `Unit ${i}`,
        createdAt: new Date(`2026-04-24T00:0${i}:00Z`),
        updatedAt: new Date(`2026-04-24T00:0${i}:00Z`),
      });
    }
    h.uomsRepo.seedUom({
      id: seededUuid(0xd999),
      merchantId: MERCHANT_B,
      code: "kg",
      name: "Kilogram",
      createdAt: new Date("2026-04-24T01:00:00Z"),
      updatedAt: new Date("2026-04-24T01:00:00Z"),
    });
  });
  afterAll(async () => {
    await h.app.close();
  });

  it("returns the merchant's UoMs in (updatedAt, id) order", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/uoms",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PullEnvelope;
    expect(body.records.map((r) => r.code)).toEqual(["pcs", "g", "ml", "cup", "btl"]);
    expect(body.nextPageToken).toBeNull();
    expect(body.nextCursor).toBe("2026-04-24T00:04:00.000Z");
  });

  it("paginates with nextPageToken", async () => {
    const first = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/uoms?limit=2",
      headers: headers(),
    });
    const firstBody = first.json() as PullEnvelope;
    expect(firstBody.records.map((r) => r.code)).toEqual(["pcs", "g"]);
    expect(firstBody.nextPageToken).toBeTruthy();

    const next = await h.app.inject({
      method: "GET",
      url: `/v1/catalog/uoms?limit=2&pageToken=${encodeURIComponent(firstBody.nextPageToken ?? "")}`,
      headers: headers(),
    });
    const nextBody = next.json() as PullEnvelope;
    expect(nextBody.records.map((r) => r.code)).toEqual(["ml", "cup"]);
  });

  it("filters by updatedAfter", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/catalog/uoms?updatedAfter=${encodeURIComponent("2026-04-24T00:02:00.000Z")}`,
      headers: headers(),
    });
    const body = res.json() as PullEnvelope;
    expect(body.records.map((r) => r.code)).toEqual(["cup", "btl"]);
  });

  it("does NOT leak UoMs from another merchant", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/uoms",
      headers: headers({ "x-staff-merchant-id": MERCHANT_B }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PullEnvelope;
    expect(body.records).toHaveLength(1);
    expect(body.records[0]?.code).toBe("kg");
  });

  it("422s an invalid limit", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/uoms?limit=abc",
      headers: headers(),
    });
    expect(res.statusCode).toBe(422);
  });

  it("400s a malformed page token", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/uoms?pageToken=garbage!@#",
      headers: headers(),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("invalid_page_token");
  });
});
