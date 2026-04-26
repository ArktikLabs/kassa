import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  type Bom,
  InMemorySalesRepository,
  type Item,
  type Outlet,
  SalesService,
} from "../src/services/sales/index.js";

/*
 * Contract tests for the verification endpoints (KASA-122 PR3):
 *
 *   GET /v1/sales/:saleId
 *   GET /v1/sales?outletId=&businessDate=
 *
 * The acceptance suite (KASA-68) reads these to assert that every offline
 * sale drained to the server with intact totals + correct lifecycle state.
 */

const MERCHANT = "11111111-1111-7111-8111-111111111111";
const OTHER_MERCHANT = "11111111-1111-7111-8111-111111111122";
const OUTLET_A = "22222222-2222-7222-8222-222222222222";
const OUTLET_B = "22222222-2222-7222-8222-222222222223";
const UOM_GR = "55555555-5555-7555-8555-555555555501";
const UOM_ML = "55555555-5555-7555-8555-555555555500";
const UOM_PCS = "55555555-5555-7555-8555-555555555502";
const ITEM_COFFEE = "44444444-4444-7444-8444-444444444401";
const ITEM_BEANS = "44444444-4444-7444-8444-444444444402";
const ITEM_MILK = "44444444-4444-7444-8444-444444444403";
const ITEM_WATER = "44444444-4444-7444-8444-444444444404";
const BOM_COFFEE = "66666666-6666-7666-8666-666666666601";

interface Fixture {
  app: FastifyInstance;
  repository: InMemorySalesRepository;
  saleA1: string;
  saleA2: string;
  saleB1: string;
  saleA1Yesterday: string;
}

function kopiPayload(localSaleId: string, outletId: string, businessDate: string, quantity = 2) {
  const subtotal = 25_000 * quantity;
  return {
    localSaleId,
    outletId,
    clerkId: "clerk-1",
    businessDate,
    createdAt: `${businessDate}T08:30:00+07:00`,
    subtotalIdr: subtotal,
    discountIdr: 0,
    totalIdr: subtotal,
    items: [
      {
        itemId: ITEM_COFFEE,
        bomId: BOM_COFFEE,
        quantity,
        uomId: UOM_PCS,
        unitPriceIdr: 25_000,
        lineTotalIdr: subtotal,
      },
    ],
    tenders: [{ method: "cash" as const, amountIdr: subtotal, reference: null }],
  };
}

async function buildFixture(): Promise<Fixture> {
  const repository = new InMemorySalesRepository();
  const items: Item[] = [
    {
      id: ITEM_COFFEE,
      merchantId: MERCHANT,
      code: "KP-001",
      name: "Kopi Susu",
      uomId: UOM_PCS,
      bomId: BOM_COFFEE,
      isStockTracked: false,
      allowNegative: false,
      isActive: true,
    },
    {
      id: ITEM_BEANS,
      merchantId: MERCHANT,
      code: "BN-001",
      name: "Biji Kopi",
      uomId: UOM_GR,
      bomId: null,
      isStockTracked: true,
      allowNegative: true,
      isActive: true,
    },
    {
      id: ITEM_MILK,
      merchantId: MERCHANT,
      code: "MK-001",
      name: "Susu",
      uomId: UOM_ML,
      bomId: null,
      isStockTracked: true,
      allowNegative: true,
      isActive: true,
    },
    {
      id: ITEM_WATER,
      merchantId: MERCHANT,
      code: "WT-001",
      name: "Air",
      uomId: UOM_ML,
      bomId: null,
      isStockTracked: true,
      allowNegative: true,
      isActive: true,
    },
  ];
  const boms: Bom[] = [
    {
      id: BOM_COFFEE,
      itemId: ITEM_COFFEE,
      version: "1",
      components: [
        { componentItemId: ITEM_BEANS, quantity: 15, uomId: UOM_GR },
        { componentItemId: ITEM_MILK, quantity: 120, uomId: UOM_ML },
        { componentItemId: ITEM_WATER, quantity: 60, uomId: UOM_ML },
      ],
    },
  ];
  const outlets: Outlet[] = [
    {
      id: OUTLET_A,
      merchantId: MERCHANT,
      code: "JKT-01",
      name: "Jakarta Pusat",
      timezone: "Asia/Jakarta",
    },
    {
      id: OUTLET_B,
      merchantId: MERCHANT,
      code: "JKT-02",
      name: "Jakarta Selatan",
      timezone: "Asia/Jakarta",
    },
  ];
  repository.seedItems(items);
  repository.seedBoms(boms);
  repository.seedOutlets(outlets);

  let serviceCursor = 0;
  const serviceIdGen = () => {
    serviceCursor += 1;
    return `018f1111-1111-7111-8111-${(serviceCursor + 0x1000).toString(16).padStart(12, "0")}`;
  };
  const service = new SalesService({
    repository,
    generateId: serviceIdGen,
    now: () => new Date("2026-04-24T08:30:01.000Z"),
    generateSaleName: (sale) =>
      `SALE-${sale.businessDate.replaceAll("-", "")}-${sale.id.slice(-4)}`,
  });
  const app = await buildApp({
    sales: { service, repository },
  });
  await app.ready();

  // Two sales on outlet A (today) so the list endpoint has > 1 row.
  const a1 = await app.inject({
    method: "POST",
    url: "/v1/sales/submit",
    headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
    payload: kopiPayload("01929b2d-1e01-7f00-80aa-000000000001", OUTLET_A, "2026-04-24", 2),
  });
  if (a1.statusCode !== 201) throw new Error(`a1 failed: ${a1.statusCode} ${a1.body}`);
  const a2 = await app.inject({
    method: "POST",
    url: "/v1/sales/submit",
    headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
    payload: kopiPayload("01929b2d-1e01-7f00-80aa-000000000002", OUTLET_A, "2026-04-24", 1),
  });
  if (a2.statusCode !== 201) throw new Error(`a2 failed: ${a2.statusCode} ${a2.body}`);
  // One sale on outlet B (today) — must NOT show up in outlet A's list.
  const b1 = await app.inject({
    method: "POST",
    url: "/v1/sales/submit",
    headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
    payload: kopiPayload("01929b2d-1e01-7f00-80aa-000000000003", OUTLET_B, "2026-04-24", 3),
  });
  if (b1.statusCode !== 201) throw new Error(`b1 failed: ${b1.statusCode} ${b1.body}`);
  // One sale on outlet A but yesterday — must NOT show up in today's list.
  const a1y = await app.inject({
    method: "POST",
    url: "/v1/sales/submit",
    headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
    payload: kopiPayload("01929b2d-1e01-7f00-80aa-000000000004", OUTLET_A, "2026-04-23", 1),
  });
  if (a1y.statusCode !== 201) throw new Error(`a1y failed: ${a1y.statusCode} ${a1y.body}`);

  return {
    app,
    repository,
    saleA1: (a1.json() as { saleId: string }).saleId,
    saleA2: (a2.json() as { saleId: string }).saleId,
    saleB1: (b1.json() as { saleId: string }).saleId,
    saleA1Yesterday: (a1y.json() as { saleId: string }).saleId,
  };
}

describe("GET /v1/sales/:saleId", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await buildFixture();
  });

  afterAll(async () => {
    await fixture.app.close();
  });

  it("rejects missing merchant context with 401", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/sales/${fixture.saleA1}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("returns 422 validation_error for a non-UUIDv7 saleId param", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: "/v1/sales/not-a-uuid",
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns 404 sale_not_found for an unknown saleId", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: "/v1/sales/018f1111-1111-7111-8111-000000999999",
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "sale_not_found" } });
  });

  it("returns 404 sale_not_found when the caller is a different merchant", async () => {
    // Cross-tenant probe must look identical to a non-existent saleId — no
    // existence leak across merchants.
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/sales/${fixture.saleA1}`,
      headers: { "x-kassa-merchant-id": OTHER_MERCHANT },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "sale_not_found" } });
  });

  it("returns the full sale row with totals, items, tenders, and lifecycle state", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/sales/${fixture.saleA1}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      saleId: string;
      outletId: string;
      businessDate: string;
      totalIdr: number;
      items: { itemId: string; quantity: number }[];
      tenders: { method: string; amountIdr: number }[];
      voidedAt: string | null;
      voidBusinessDate: string | null;
      voidReason: string | null;
      refunds: unknown[];
    };
    expect(body.saleId).toBe(fixture.saleA1);
    expect(body.outletId).toBe(OUTLET_A);
    expect(body.businessDate).toBe("2026-04-24");
    expect(body.totalIdr).toBe(50_000);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ itemId: ITEM_COFFEE, quantity: 2 });
    expect(body.tenders[0]).toMatchObject({ method: "cash", amountIdr: 50_000 });
    // A live sale: no void, no refunds.
    expect(body.voidedAt).toBeNull();
    expect(body.voidBusinessDate).toBeNull();
    expect(body.voidReason).toBeNull();
    expect(body.refunds).toEqual([]);
  });

  it("reflects void state after POST /void", async () => {
    const voidRes = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleA1}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: {
        voidedAt: "2026-04-24T09:00:00+07:00",
        voidBusinessDate: "2026-04-24",
        reason: "wrong cup",
      },
    });
    expect(voidRes.statusCode).toBe(201);

    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/sales/${fixture.saleA1}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      voidedAt: string | null;
      voidBusinessDate: string | null;
      voidReason: string | null;
    };
    expect(body.voidedAt).toBe("2026-04-24T09:00:00+07:00");
    expect(body.voidBusinessDate).toBe("2026-04-24");
    expect(body.voidReason).toBe("wrong cup");
  });

  it("reflects refund state after POST /refund", async () => {
    const refundRes = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleA1}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: {
        clientRefundId: "01929b2d-1e01-7f00-80aa-0000000000a1",
        refundedAt: "2026-04-24T10:00:00+07:00",
        refundBusinessDate: "2026-04-24",
        amountIdr: 25_000,
        lines: [{ itemId: ITEM_COFFEE, quantity: 1 }],
        reason: "spill",
      },
    });
    expect(refundRes.statusCode).toBe(201);

    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/sales/${fixture.saleA1}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      refunds: {
        clientRefundId: string;
        amountIdr: number;
        refundBusinessDate: string;
        lines: { itemId: string; quantity: number }[];
      }[];
    };
    expect(body.refunds).toHaveLength(1);
    expect(body.refunds[0]).toMatchObject({
      clientRefundId: "01929b2d-1e01-7f00-80aa-0000000000a1",
      amountIdr: 25_000,
      refundBusinessDate: "2026-04-24",
    });
    expect(body.refunds[0]?.lines).toEqual([{ itemId: ITEM_COFFEE, quantity: 1 }]);
  });
});

describe("GET /v1/sales", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await buildFixture();
  });

  afterAll(async () => {
    await fixture.app.close();
  });

  it("rejects missing merchant context with 401", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/sales?outletId=${OUTLET_A}&businessDate=2026-04-24`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("returns 422 validation_error for a missing outletId", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: "/v1/sales?businessDate=2026-04-24",
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns 422 validation_error for a malformed businessDate", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/sales?outletId=${OUTLET_A}&businessDate=04-24-2026`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns only sales matching (merchant, outlet, businessDate)", async () => {
    // Outlet A on 2026-04-24 has saleA1 + saleA2; outlet B's b1 and yesterday's
    // a1y must be excluded.
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/sales?outletId=${OUTLET_A}&businessDate=2026-04-24`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { records: { saleId: string; totalIdr: number }[] };
    const ids = body.records.map((r) => r.saleId);
    expect(ids).toEqual(expect.arrayContaining([fixture.saleA1, fixture.saleA2]));
    expect(ids).not.toContain(fixture.saleB1);
    expect(ids).not.toContain(fixture.saleA1Yesterday);
    expect(body.records).toHaveLength(2);
  });

  it("returns sales ordered by createdAt ascending (deterministic for EOD rollups)", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/sales?outletId=${OUTLET_A}&businessDate=2026-04-24`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { records: { createdAt: string }[] };
    for (let i = 1; i < body.records.length; i += 1) {
      const prev = body.records[i - 1]?.createdAt as string;
      const curr = body.records[i]?.createdAt as string;
      expect(prev <= curr).toBe(true);
    }
  });

  it("returns an empty list for a bucket with no sales", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/sales?outletId=${OUTLET_A}&businessDate=2026-04-22`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ records: [] });
  });

  it("returns an empty list when called by a different merchant", async () => {
    // No existence leak: outlet A clearly has sales, but a foreign merchant
    // sees an empty bucket — same shape as a genuinely empty bucket above.
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/sales?outletId=${OUTLET_A}&businessDate=2026-04-24`,
      headers: { "x-kassa-merchant-id": OTHER_MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ records: [] });
  });

  it("includes void/refund lifecycle in the listed records", async () => {
    await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleA1}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: {
        voidedAt: "2026-04-24T09:00:00+07:00",
        voidBusinessDate: "2026-04-24",
      },
    });

    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/sales?outletId=${OUTLET_A}&businessDate=2026-04-24`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      records: { saleId: string; voidedAt: string | null }[];
    };
    const a1 = body.records.find((r) => r.saleId === fixture.saleA1);
    expect(a1?.voidedAt).toBe("2026-04-24T09:00:00+07:00");
    const a2 = body.records.find((r) => r.saleId === fixture.saleA2);
    expect(a2?.voidedAt).toBeNull();
  });
});
