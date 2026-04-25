import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  BomsService,
  InMemoryBomsRepository,
  InMemoryItemsRepository,
  ItemsService,
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
  bomsRepo: InMemoryBomsRepository;
}

async function setup(): Promise<Harness> {
  const bomsRepo = new InMemoryBomsRepository();
  const bomsService = new BomsService({ repository: bomsRepo });
  const items = new ItemsService({ repository: new InMemoryItemsRepository() });
  const app = await buildApp({
    catalog: { items, boms: bomsService, staffBootstrapToken: STAFF_TOKEN },
  });
  await app.ready();
  return { app, bomsRepo };
}

function headers(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${STAFF_TOKEN}`,
    "x-staff-user-id": STAFF_USER,
    "x-staff-merchant-id": MERCHANT_A,
    ...overrides,
  };
}

interface BomBody {
  id: string;
  itemId: string;
  components: { componentItemId: string; quantity: number; uomId: string }[];
  updatedAt: string;
}

interface PullEnvelope {
  records: BomBody[];
  nextCursor: string | null;
  nextPageToken: string | null;
}

const ITEM_A = seededUuid(0xa001);
const ITEM_B = seededUuid(0xa002);
const UOM_A = seededUuid(0xc001);

describe("/v1/catalog/boms — auth gating", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.app.close();
  });

  it("401s when no bearer is present", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/catalog/boms" });
    expect(res.statusCode).toBe(401);
  });

  it("400s when X-Staff-Merchant-Id is missing", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/boms",
      headers: {
        authorization: `Bearer ${STAFF_TOKEN}`,
        "x-staff-user-id": STAFF_USER,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/catalog/boms — pull pagination + tenant isolation", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
    for (let i = 0; i < 5; i++) {
      h.bomsRepo.seedBom({
        id: seededUuid(0xb000 + i),
        merchantId: MERCHANT_A,
        itemId: ITEM_A,
        components: [{ componentItemId: ITEM_B, quantity: 2 + i * 0.5, uomId: UOM_A }],
        updatedAt: new Date(`2026-04-24T00:0${i}:00Z`),
      });
    }
    h.bomsRepo.seedBom({
      id: seededUuid(0xc999),
      merchantId: MERCHANT_B,
      itemId: ITEM_A,
      components: [{ componentItemId: ITEM_B, quantity: 1, uomId: UOM_A }],
      updatedAt: new Date("2026-04-24T01:00:00Z"),
    });
  });
  afterAll(async () => {
    await h.app.close();
  });

  it("returns every merchant-A row with embedded components and a closing cursor", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/boms",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PullEnvelope;
    expect(body.records).toHaveLength(5);
    expect(body.records[0]?.components).toEqual([
      { componentItemId: ITEM_B, quantity: 2, uomId: UOM_A },
    ]);
    expect(body.nextPageToken).toBeNull();
    expect(body.nextCursor).toBe("2026-04-24T00:04:00.000Z");
  });

  it("paginates and walks the rest of the set with nextPageToken", async () => {
    const first = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/boms?limit=2",
      headers: headers(),
    });
    const firstBody = first.json() as PullEnvelope;
    expect(firstBody.records).toHaveLength(2);
    expect(firstBody.nextPageToken).toBeTruthy();
    expect(firstBody.nextCursor).toBeNull();

    const second = await h.app.inject({
      method: "GET",
      url: `/v1/catalog/boms?limit=2&pageToken=${encodeURIComponent(firstBody.nextPageToken ?? "")}`,
      headers: headers(),
    });
    const secondBody = second.json() as PullEnvelope;
    expect(secondBody.records).toHaveLength(2);

    const third = await h.app.inject({
      method: "GET",
      url: `/v1/catalog/boms?limit=2&pageToken=${encodeURIComponent(secondBody.nextPageToken ?? "")}`,
      headers: headers(),
    });
    const thirdBody = third.json() as PullEnvelope;
    expect(thirdBody.records).toHaveLength(1);
    expect(thirdBody.nextPageToken).toBeNull();
  });

  it("does NOT leak BOMs from another merchant", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/boms",
      headers: headers({ "x-staff-merchant-id": MERCHANT_B }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PullEnvelope;
    expect(body.records).toHaveLength(1);
    expect(body.records[0]?.id).toBe(seededUuid(0xc999));
  });

  it("filters by updatedAfter", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/catalog/boms?updatedAfter=${encodeURIComponent("2026-04-24T00:02:00.000Z")}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PullEnvelope;
    expect(body.records).toHaveLength(2);
  });

  it("422s an invalid limit", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/boms?limit=0",
      headers: headers(),
    });
    expect(res.statusCode).toBe(422);
  });

  it("400s a malformed page token", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/catalog/boms?pageToken=not-a-token",
      headers: headers(),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("invalid_page_token");
  });
});
