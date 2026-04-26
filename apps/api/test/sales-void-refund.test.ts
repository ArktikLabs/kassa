import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  InMemorySalesRepository,
  SalesService,
  type Bom,
  type Item,
  type Outlet,
} from "../src/services/sales/index.js";

/*
 * Contract tests for POST /v1/sales/:saleId/void and /refund (KASA-122 PR2).
 *
 * Each test starts with a freshly seeded merchant + outlets + items + BOMs
 * and submits one canonical "Kopi Susu × 2" sale (cash 50_000) so the void
 * and refund cases have a real saleId + ledger to mirror.
 */

const MERCHANT = "11111111-1111-7111-8111-111111111111";
const OTHER_MERCHANT = "11111111-1111-7111-8111-111111111122";
const OUTLET = "22222222-2222-7222-8222-222222222222";
const UOM_GR = "55555555-5555-7555-8555-555555555501";
const UOM_ML = "55555555-5555-7555-8555-555555555500";
const UOM_PCS = "55555555-5555-7555-8555-555555555502";
const ITEM_COFFEE = "44444444-4444-7444-8444-444444444401";
const ITEM_BEANS = "44444444-4444-7444-8444-444444444402";
const ITEM_MILK = "44444444-4444-7444-8444-444444444403";
const ITEM_WATER = "44444444-4444-7444-8444-444444444404";
const ITEM_BOTTLED = "44444444-4444-7444-8444-444444444405";
const BOM_COFFEE = "66666666-6666-7666-8666-666666666601";

interface Fixture {
  app: FastifyInstance;
  repository: InMemorySalesRepository;
  saleId: string;
}

function kopiPayload(localSaleId: string, quantity = 2) {
  const subtotal = 25_000 * quantity;
  return {
    localSaleId,
    outletId: OUTLET,
    clerkId: "clerk-1",
    businessDate: "2026-04-24",
    createdAt: "2026-04-24T08:30:00+07:00",
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
      priceIdr: 25_000,
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
      priceIdr: 0,
      uomId: UOM_GR,
      bomId: null,
      isStockTracked: true,
      allowNegative: false,
      isActive: true,
    },
    {
      id: ITEM_MILK,
      merchantId: MERCHANT,
      code: "MK-001",
      name: "Susu",
      priceIdr: 0,
      uomId: UOM_ML,
      bomId: null,
      isStockTracked: true,
      allowNegative: false,
      isActive: true,
    },
    {
      id: ITEM_WATER,
      merchantId: MERCHANT,
      code: "WT-001",
      name: "Air",
      priceIdr: 0,
      uomId: UOM_ML,
      bomId: null,
      isStockTracked: true,
      allowNegative: true,
      isActive: true,
    },
    {
      id: ITEM_BOTTLED,
      merchantId: MERCHANT,
      code: "BT-001",
      name: "Air Botol",
      priceIdr: 8_000,
      uomId: UOM_PCS,
      bomId: null,
      isStockTracked: true,
      allowNegative: false,
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
      id: OUTLET,
      merchantId: MERCHANT,
      code: "JKT-01",
      name: "Jakarta Pusat",
      timezone: "Asia/Jakarta",
    },
  ];
  repository.seedItems(items);
  repository.seedBoms(boms);
  repository.seedOutlets(outlets);

  let seedCursor = 0;
  const seedIdGen = () => {
    seedCursor += 1;
    return `018f0000-0000-7000-8000-${seedCursor.toString(16).padStart(12, "0")}`;
  };
  repository.seedLedger(
    [
      {
        outletId: OUTLET,
        itemId: ITEM_BEANS,
        delta: 500,
        reason: "adjustment",
        refType: null,
        refId: null,
        occurredAt: "2026-04-23T00:00:00.000Z",
      },
      {
        outletId: OUTLET,
        itemId: ITEM_MILK,
        delta: 1_000,
        reason: "adjustment",
        refType: null,
        refId: null,
        occurredAt: "2026-04-23T00:00:00.000Z",
      },
      {
        outletId: OUTLET,
        itemId: ITEM_BOTTLED,
        delta: 10,
        reason: "adjustment",
        refType: null,
        refId: null,
        occurredAt: "2026-04-23T00:00:00.000Z",
      },
    ],
    seedIdGen,
  );

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

  // Submit a baseline sale to get a saleId for void/refund tests.
  const submitRes = await app.inject({
    method: "POST",
    url: "/v1/sales/submit",
    headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
    payload: kopiPayload("01929b2d-1e01-7f00-80aa-000000000001", 2),
  });
  if (submitRes.statusCode !== 201) {
    throw new Error(`baseline submit failed: ${submitRes.statusCode} ${submitRes.body}`);
  }
  const saleId = (submitRes.json() as { saleId: string }).saleId;
  return { app, repository, saleId };
}

describe("POST /v1/sales/:saleId/void", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await buildFixture();
  });

  afterAll(async () => {
    await fixture.app.close();
  });

  it("rejects missing merchant context with 401", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      payload: { voidedAt: "2026-04-24T09:00:00+07:00", voidBusinessDate: "2026-04-24" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("returns 422 validation_error for a missing voidedAt", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: { voidBusinessDate: "2026-04-24" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns 422 validation_error for a non-UUIDv7 saleId param", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/not-a-uuid/void",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: { voidedAt: "2026-04-24T09:00:00+07:00", voidBusinessDate: "2026-04-24" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns 404 sale_not_found for a sale that does not exist", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/018f1111-1111-7111-8111-000000999999/void",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: { voidedAt: "2026-04-24T09:00:00+07:00", voidBusinessDate: "2026-04-24" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "sale_not_found" } });
  });

  it("returns 404 sale_not_found when called by a different merchant", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": OTHER_MERCHANT, "content-type": "application/json" },
      payload: { voidedAt: "2026-04-24T09:00:00+07:00", voidBusinessDate: "2026-04-24" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "sale_not_found" } });
  });

  it("voids a sale, mirroring the original ledger with positive sale_void rows", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: {
        voidedAt: "2026-04-24T09:00:00+07:00",
        voidBusinessDate: "2026-04-24",
        reason: "wrong cup",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      saleId: string;
      voidedAt: string;
      voidBusinessDate: string;
      reason: string | null;
      ledger: { itemId: string; delta: number; reason: string; refType: string; refId: string }[];
    };
    expect(body.saleId).toBe(fixture.saleId);
    expect(body.voidedAt).toBe("2026-04-24T09:00:00+07:00");
    expect(body.voidBusinessDate).toBe("2026-04-24");
    expect(body.reason).toBe("wrong cup");

    // The baseline sale (Kopi × 2) wrote: -30 BEANS, -240 MILK, -120 WATER.
    // Void must mirror with +30, +240, +120 keyed to refType=sale, refId=saleId.
    const byItem = Object.fromEntries(body.ledger.map((row) => [row.itemId, row]));
    expect(byItem[ITEM_BEANS]?.delta).toBe(30);
    expect(byItem[ITEM_MILK]?.delta).toBe(240);
    expect(byItem[ITEM_WATER]?.delta).toBe(120);
    expect(byItem[ITEM_COFFEE]).toBeUndefined();
    for (const row of body.ledger) {
      expect(row.reason).toBe("sale_void");
      expect(row.refType).toBe("sale");
      expect(row.refId).toBe(fixture.saleId);
    }

    // The on-hand should now match the seeded values exactly (sale + void = 0).
    const onHand = await fixture.repository.allOnHandForOutlet(OUTLET);
    expect(onHand.get(ITEM_BEANS)).toBe(500);
    expect(onHand.get(ITEM_MILK)).toBe(1_000);
  });

  it("is idempotent on saleId: a second void returns 200 with empty ledger", async () => {
    const payload = {
      voidedAt: "2026-04-24T09:00:00+07:00",
      voidBusinessDate: "2026-04-24",
      reason: "wrong cup",
    };
    const first = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: { ...payload, voidedAt: "2026-04-24T10:00:00+07:00" },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json() as { voidedAt: string; ledger: unknown[] };
    // Server keeps the originally stamped voidedAt; replay is a read.
    expect(body.voidedAt).toBe("2026-04-24T09:00:00+07:00");
    expect(body.ledger).toEqual([]);

    // No double balancing — only the original three sale_void entries exist.
    const ledger = fixture.repository._peekLedger();
    const voidEntries = ledger.filter((row) => row.reason === "sale_void");
    expect(voidEntries).toHaveLength(3);
  });
});

describe("POST /v1/sales/:saleId/refund", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await buildFixture();
  });

  afterAll(async () => {
    await fixture.app.close();
  });

  const baseRefund = (overrides: Record<string, unknown> = {}) => ({
    clientRefundId: "01929c00-0001-7000-8000-000000000001",
    refundedAt: "2026-04-24T09:30:00+07:00",
    refundBusinessDate: "2026-04-24",
    amountIdr: 25_000,
    lines: [{ itemId: ITEM_COFFEE, quantity: 1 }],
    ...overrides,
  });

  it("rejects missing merchant context with 401", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      payload: baseRefund(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 422 validation_error for missing clientRefundId", async () => {
    const { clientRefundId: _omit, ...partial } = baseRefund();
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: partial,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns 404 sale_not_found for a sale that does not exist", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/018f1111-1111-7111-8111-000000999999/refund",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: baseRefund(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "sale_not_found" } });
  });

  it("books a partial refund and writes balancing positive ledger rows", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: baseRefund(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      saleId: string;
      refundId: string;
      clientRefundId: string;
      amountIdr: number;
      ledger: { itemId: string; delta: number; reason: string; refType: string; refId: string }[];
    };
    expect(body.saleId).toBe(fixture.saleId);
    expect(body.amountIdr).toBe(25_000);
    expect(body.clientRefundId).toBe("01929c00-0001-7000-8000-000000000001");

    // Refunding 1 of 2 cups returns half the components.
    const byItem = Object.fromEntries(body.ledger.map((row) => [row.itemId, row]));
    expect(byItem[ITEM_BEANS]?.delta).toBe(15);
    expect(byItem[ITEM_MILK]?.delta).toBe(120);
    expect(byItem[ITEM_WATER]?.delta).toBe(60);
    for (const row of body.ledger) {
      expect(row.reason).toBe("refund");
      expect(row.refType).toBe("sale");
      expect(row.refId).toBe(fixture.saleId);
    }
  });

  it("is idempotent on clientRefundId: a replay returns 200 with the original refundId and empty ledger", async () => {
    const first = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: baseRefund(),
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { refundId: string };

    const second = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: baseRefund(),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { refundId: string; ledger: unknown[] };
    expect(secondBody.refundId).toBe(firstBody.refundId);
    expect(secondBody.ledger).toEqual([]);
  });

  it("returns 409 refund_idempotency_conflict when the same clientRefundId arrives with a different shape", async () => {
    await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: baseRefund(),
    });
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: baseRefund({ amountIdr: 50_000 }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "refund_idempotency_conflict" } });
  });

  it("returns 422 refund_line_not_in_sale when refunding an item that is not on the sale", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: baseRefund({ lines: [{ itemId: ITEM_BOTTLED, quantity: 1 }] }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "refund_line_not_in_sale" } });
  });

  it("returns 422 refund_quantity_exceeds_remaining when over-refunding a line", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: baseRefund({ lines: [{ itemId: ITEM_COFFEE, quantity: 5 }] }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "refund_quantity_exceeds_remaining" } });
  });

  it("returns 422 refund_quantity_exceeds_remaining when duplicate lines aggregate above remaining", async () => {
    // First book a 1-cup refund so only 1 cup remains refundable on the
    // 2-cup sale. Then attempt a refund with two duplicate lines for the
    // same itemId (each at qty 1) — the aggregate (2) must exceed the
    // remaining (1) and be rejected, even though each individual line
    // looks fine on its own.
    const firstRefund = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: baseRefund({
        clientRefundId: "01929c00-0001-7000-8000-0000000000aa",
      }),
    });
    expect(firstRefund.statusCode).toBe(201);

    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: baseRefund({
        clientRefundId: "01929c00-0001-7000-8000-0000000000bb",
        amountIdr: 25_000,
        lines: [
          { itemId: ITEM_COFFEE, quantity: 1 },
          { itemId: ITEM_COFFEE, quantity: 1 },
        ],
      }),
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string; details?: { requested?: number } } };
    expect(body.error.code).toBe("refund_quantity_exceeds_remaining");
    expect(body.error.details?.requested).toBe(2);

    // Belt-and-braces: no second refund row, no extra ledger writes.
    const ledger = fixture.repository._peekLedger();
    const refundEntries = ledger.filter((row) => row.reason === "refund");
    // First refund wrote 3 component rows (beans/milk/water); the rejected
    // duplicate-line refund must not have added more.
    expect(refundEntries).toHaveLength(3);
  });

  it("returns 422 refund_amount_exceeds_remaining when refunds would exceed the sale total", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: baseRefund({ amountIdr: 60_000 }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "refund_amount_exceeds_remaining" } });
  });

  it("returns 422 sale_voided when the sale has been voided", async () => {
    const voidRes = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: { voidedAt: "2026-04-24T09:00:00+07:00", voidBusinessDate: "2026-04-24" },
    });
    expect(voidRes.statusCode).toBe(201);

    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: baseRefund(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "sale_voided" } });
  });
});

describe("POST /v1/sales/:saleId/void after refunds", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await buildFixture();
  });

  afterAll(async () => {
    await fixture.app.close();
  });

  it("returns 422 sale_has_refunds when refunds already exist on the sale", async () => {
    // Book one refund first.
    const refundRes = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/refund`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: {
        clientRefundId: "01929c00-0001-7000-8000-000000000099",
        refundedAt: "2026-04-24T09:30:00+07:00",
        refundBusinessDate: "2026-04-24",
        amountIdr: 25_000,
        lines: [{ itemId: ITEM_COFFEE, quantity: 1 }],
      },
    });
    expect(refundRes.statusCode).toBe(201);

    const voidRes = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: { voidedAt: "2026-04-24T10:00:00+07:00", voidBusinessDate: "2026-04-24" },
    });
    expect(voidRes.statusCode).toBe(422);
    expect(voidRes.json()).toMatchObject({ error: { code: "sale_has_refunds" } });
  });
});
