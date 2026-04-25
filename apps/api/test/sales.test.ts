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
 * Integration tests for POST /v1/sales/submit + GET /v1/stock/snapshot (KASA-66).
 * We build a fresh Fastify app per test so the in-memory sales repository
 * starts empty, then seed a merchant / outlets / items / BOMs and exercise
 * the documented acceptance scenarios:
 *
 *  - BOM explosion writes one ledger row per component.
 *  - Non-BOM tracked items decrement their own row.
 *  - `allow_negative = false` refuses a sale that would take on_hand negative.
 *  - `allow_negative = true` lets the sale through for raw materials.
 *  - Concurrent sales at different outlets do not cross-decrement.
 *  - Idempotency: replaying the same localSaleId returns 409 with the same sale name.
 *  - The exposed snapshot endpoint mirrors the ledger sums.
 */

const MERCHANT = "11111111-1111-7111-8111-111111111111";
const OUTLET_A = "22222222-2222-7222-8222-222222222222";
const OUTLET_B = "22222222-2222-7222-8222-222222222299";
const UOM_ML = "55555555-5555-7555-8555-555555555500";
const UOM_GR = "55555555-5555-7555-8555-555555555501";
const UOM_PCS = "55555555-5555-7555-8555-555555555502";
const ITEM_COFFEE = "44444444-4444-7444-8444-444444444401";
const ITEM_BEANS = "44444444-4444-7444-8444-444444444402";
const ITEM_MILK = "44444444-4444-7444-8444-444444444403";
const ITEM_WATER = "44444444-4444-7444-8444-444444444404";
const ITEM_BOTTLED = "44444444-4444-7444-8444-444444444405";
const ITEM_SUGAR = "44444444-4444-7444-8444-444444444406";
const BOM_COFFEE = "66666666-6666-7666-8666-666666666601";

function kopi(quantity: number, localSaleId: string, outletId = OUTLET_A) {
  const subtotal = 25_000 * quantity;
  return {
    localSaleId,
    outletId,
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
    tenders: [
      {
        method: "cash" as const,
        amountIdr: subtotal,
        reference: null,
      },
    ],
  };
}

async function buildFixture(options?: {
  beansOnHandOutletA?: number;
  beansOnHandOutletB?: number;
  bottledOnHand?: number;
  sugarOnHand?: number;
}): Promise<{ app: FastifyInstance; repository: InMemorySalesRepository }> {
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
      allowNegative: false,
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
      allowNegative: false,
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
      // Raw material managed outside the system — allow negative per AC.
      allowNegative: true,
      isActive: true,
    },
    {
      id: ITEM_BOTTLED,
      merchantId: MERCHANT,
      code: "BT-001",
      name: "Air Botol",
      uomId: UOM_PCS,
      bomId: null,
      isStockTracked: true,
      allowNegative: false,
      isActive: true,
    },
    {
      id: ITEM_SUGAR,
      merchantId: MERCHANT,
      code: "SG-001",
      name: "Gula",
      uomId: UOM_GR,
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
  let seedCursor = 0;
  const seedIdGen = () => {
    seedCursor += 1;
    // UUIDv7-shaped deterministic seed ids so parse validation on the wire
    // schema stays happy.
    const hex = seedCursor.toString(16).padStart(12, "0");
    return `018f0000-0000-7000-8000-${hex}`;
  };
  repository.seedLedger(
    [
      {
        outletId: OUTLET_A,
        itemId: ITEM_BEANS,
        delta: options?.beansOnHandOutletA ?? 500,
        reason: "adjustment",
        refType: null,
        refId: null,
        occurredAt: "2026-04-23T00:00:00.000Z",
      },
      {
        outletId: OUTLET_A,
        itemId: ITEM_MILK,
        delta: 1_000,
        reason: "adjustment",
        refType: null,
        refId: null,
        occurredAt: "2026-04-23T00:00:00.000Z",
      },
      {
        outletId: OUTLET_A,
        itemId: ITEM_BOTTLED,
        delta: options?.bottledOnHand ?? 10,
        reason: "adjustment",
        refType: null,
        refId: null,
        occurredAt: "2026-04-23T00:00:00.000Z",
      },
      {
        outletId: OUTLET_A,
        itemId: ITEM_SUGAR,
        delta: options?.sugarOnHand ?? 0,
        reason: "adjustment",
        refType: null,
        refId: null,
        occurredAt: "2026-04-23T00:00:00.000Z",
      },
      // Outlet B has its own stock — these exist only so we can assert
      // outlet A's sale does not move outlet B's rows.
      {
        outletId: OUTLET_B,
        itemId: ITEM_BEANS,
        delta: options?.beansOnHandOutletB ?? 200,
        reason: "adjustment",
        refType: null,
        refId: null,
        occurredAt: "2026-04-23T00:00:00.000Z",
      },
      {
        outletId: OUTLET_B,
        itemId: ITEM_MILK,
        delta: 800,
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
    const hex = (serviceCursor + 0x1000).toString(16).padStart(12, "0");
    return `018f1111-1111-7111-8111-${hex}`;
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
  return { app, repository };
}

describe("POST /v1/sales/submit", () => {
  let fixture: { app: FastifyInstance; repository: InMemorySalesRepository };

  beforeEach(async () => {
    fixture = await buildFixture();
  });

  it("rejects missing merchant context with 401", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      payload: kopi(1, "01929b2d-1e01-7f00-80aa-000000000001"),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("explodes a BOM-backed sale into per-component ledger rows", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: kopi(2, "01929b2d-1e02-7f00-80aa-000000000002"),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      saleId: string;
      name: string;
      localSaleId: string;
      ledger: {
        itemId: string;
        delta: number;
        reason: string;
        refType: string | null;
        refId: string | null;
      }[];
    };
    expect(body.localSaleId).toBe("01929b2d-1e02-7f00-80aa-000000000002");
    expect(body.name).toMatch(/^SALE-20260424-/);
    const byItem = Object.fromEntries(body.ledger.map((row) => [row.itemId, row]));
    expect(byItem[ITEM_BEANS]?.delta).toBe(-30);
    expect(byItem[ITEM_MILK]?.delta).toBe(-240);
    expect(byItem[ITEM_WATER]?.delta).toBe(-120);
    expect(byItem[ITEM_COFFEE]).toBeUndefined(); // finished good never moves
    for (const row of body.ledger) {
      expect(row.reason).toBe("sale");
      expect(row.refType).toBe("sale");
      expect(row.refId).toBe(body.saleId);
    }
  });

  it("decrements non-BOM tracked items as a single summary entry", async () => {
    const payload = {
      ...kopi(1, "01929b2d-1e03-7f00-80aa-000000000003"),
      items: [
        {
          itemId: ITEM_BOTTLED,
          bomId: null,
          quantity: 3,
          uomId: UOM_PCS,
          unitPriceIdr: 8_000,
          lineTotalIdr: 24_000,
        },
      ],
      subtotalIdr: 24_000,
      totalIdr: 24_000,
      tenders: [{ method: "cash" as const, amountIdr: 24_000, reference: null }],
    };
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      saleId: string;
      ledger: {
        itemId: string;
        delta: number;
        reason: string;
        refType: string | null;
        refId: string | null;
      }[];
    };
    expect(body.ledger).toHaveLength(1);
    expect(body.ledger[0]).toMatchObject({
      itemId: ITEM_BOTTLED,
      delta: -3,
      reason: "sale",
      refType: "sale",
      refId: body.saleId,
    });
  });

  it("rejects a sale that would take on_hand negative for a guarded item", async () => {
    const lowStock = await buildFixture({ beansOnHandOutletA: 10 });
    const res = await lowStock.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: kopi(2, "01929b2d-1e04-7f00-80aa-000000000004"),
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string; details?: { itemCode: string } } };
    expect(body.error.code).toBe("insufficient_stock");
    expect(body.error.details?.itemCode).toBe("BN-001");
    // No ledger row should have been written on refusal.
    expect(lowStock.repository._peekLedger().every((row) => row.reason !== "sale")).toBe(true);
    expect(lowStock.repository._peekSales()).toHaveLength(0);
    await lowStock.app.close();
  });

  it("lets the sale through when the item has allow_negative = true", async () => {
    // ITEM_WATER has allowNegative=true and is a BOM component: its seeded
    // on_hand is 0 (no adjustment row), so 2 cups of Kopi Susu would move it
    // to -120. The guard must skip this item.
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: kopi(2, "01929b2d-1e05-7f00-80aa-000000000005"),
    });
    expect(res.statusCode).toBe(201);
  });

  it("keeps outlets isolated — a sale at outlet A does not touch outlet B's rows", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: kopi(2, "01929b2d-1e06-7f00-80aa-000000000006", OUTLET_A),
    });
    expect(res.statusCode).toBe(201);
    const outletBBeans = await fixture.repository.onHandFor(OUTLET_B, ITEM_BEANS);
    const outletBMilk = await fixture.repository.onHandFor(OUTLET_B, ITEM_MILK);
    expect(outletBBeans).toBe(200);
    expect(outletBMilk).toBe(800);
    const outletABeans = await fixture.repository.onHandFor(OUTLET_A, ITEM_BEANS);
    expect(outletABeans).toBe(500 - 30);
  });

  it("returns 409 on idempotent replay with the same localSaleId and payload", async () => {
    const payload = kopi(1, "01929b2d-1e07-7f00-80aa-000000000007");
    const first = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { saleId: string; name: string };

    const second = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload,
    });
    expect(second.statusCode).toBe(409);
    const secondBody = second.json() as { saleId: string; name: string; ledger: unknown[] };
    expect(secondBody.saleId).toBe(firstBody.saleId);
    expect(secondBody.name).toBe(firstBody.name);
    expect(secondBody.ledger).toEqual([]);
    // No second sale row; no second round of ledger entries.
    expect(fixture.repository._peekSales()).toHaveLength(1);
    const saleRows = fixture.repository._peekLedger().filter((row) => row.reason === "sale");
    expect(saleRows).toHaveLength(3);
  });

  it("rejects a mismatching replay as an idempotency conflict", async () => {
    await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: kopi(1, "01929b2d-1e08-7f00-80aa-000000000008"),
    });
    const bad = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: kopi(2, "01929b2d-1e08-7f00-80aa-000000000008"),
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
  });

  it("accepts a qris_static tender and persists it as unverified with buyerRefLast4", async () => {
    const payload = {
      ...kopi(1, "01929b2d-1e10-7f00-80aa-000000000010"),
      tenders: [
        {
          method: "qris_static" as const,
          amountIdr: 25_000,
          reference: null,
          buyerRefLast4: "1234",
        },
      ],
    };
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(201);

    const sales = fixture.repository._peekSales();
    expect(sales).toHaveLength(1);
    expect(sales[0]?.tenders).toEqual([
      {
        method: "qris_static",
        amountIdr: 25_000,
        reference: null,
        verified: false,
        buyerRefLast4: "1234",
      },
    ]);
  });

  it("rejects a qris_static tender missing buyerRefLast4 with 400", async () => {
    const payload = {
      ...kopi(1, "01929b2d-1e11-7f00-80aa-000000000011"),
      tenders: [
        {
          method: "qris_static" as const,
          amountIdr: 25_000,
          reference: null,
        },
      ],
    };
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  it("rejects a qris_static tender that arrives already verified with 400", async () => {
    const payload = {
      ...kopi(1, "01929b2d-1e12-7f00-80aa-000000000012"),
      tenders: [
        {
          method: "qris_static" as const,
          amountIdr: 25_000,
          reference: null,
          buyerRefLast4: "5678",
          verified: true,
        },
      ],
    };
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  afterAll(async () => {
    await fixture.app.close();
  });
});

describe("GET /v1/stock/snapshot", () => {
  let app: FastifyInstance;
  let repository: InMemorySalesRepository;

  beforeAll(async () => {
    const fixture = await buildFixture();
    app = fixture.app;
    repository = fixture.repository;
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns the ledger-sum on_hand for an outlet", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/stock/snapshot?outlet=${OUTLET_A}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      records: { outletId: string; itemId: string; onHand: number }[];
    };
    const byItem = Object.fromEntries(body.records.map((row) => [row.itemId, row.onHand]));
    expect(byItem[ITEM_BEANS]).toBe(500);
    expect(byItem[ITEM_MILK]).toBe(1_000);
    expect(byItem[ITEM_BOTTLED]).toBe(10);
    for (const row of body.records) {
      expect(row.outletId).toBe(OUTLET_A);
    }
  });

  it("rejects a missing outlet query param with 422 validation_error", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/stock/snapshot",
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as {
      error: { code: string; details: { issues: Array<{ source: string; path: string }> } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details.issues[0]?.source).toBe("query");
    expect(body.error.details.issues[0]?.path).toBe("outlet");
  });

  it("rejects unknown outlets with 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/stock/snapshot?outlet=${ITEM_COFFEE}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(404);
  });

  it("reflects a sale — on_hand drops after a BOM-explode submit", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: kopi(1, "01929b2d-1e09-7f00-80aa-000000000009"),
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/stock/snapshot?outlet=${OUTLET_A}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    const body = res.json() as { records: { itemId: string; onHand: number }[] };
    const byItem = Object.fromEntries(body.records.map((row) => [row.itemId, row.onHand]));
    expect(byItem[ITEM_BEANS]).toBe(500 - 15);
    expect(byItem[ITEM_MILK]).toBe(1_000 - 120);
    // Sanity — repository agrees
    expect(await repository.onHandFor(OUTLET_A, ITEM_BEANS)).toBe(485);
  });
});
