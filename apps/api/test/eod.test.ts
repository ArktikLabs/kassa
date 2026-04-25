import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { EodService, InMemoryEodDataPlane, type SaleRecord } from "../src/services/eod/index.js";

const MERCHANT_ID = "01890abc-1234-7def-8000-00000000a001";
const OUTLET_ID = "01890abc-1234-7def-8000-000000000001";
const CLERK_ID = "01890abc-1234-7def-8000-00000000c001";
const ITEM_ID = "01890abc-1234-7def-8000-000000000b01";
const UOM_ID = "01890abc-1234-7def-8000-000000000b02";
const CLOCK_NOW = new Date("2026-04-23T12:00:00+07:00");

interface Harness {
  app: FastifyInstance;
  dataPlane: InMemoryEodDataPlane;
  service: EodService;
  idCursor: number;
}

async function setup(): Promise<Harness> {
  const dataPlane = new InMemoryEodDataPlane();
  let idCursor = 0;
  const service = new EodService({
    dataPlane,
    now: () => CLOCK_NOW,
    generateEodId: () => {
      idCursor += 1;
      return `01890abc-1234-7def-8000-0000000eee0${idCursor}`;
    },
  });
  const app = await buildApp({
    eod: { service, resolveMerchantId: () => MERCHANT_ID },
  });
  await app.ready();
  return { app, dataPlane, service, idCursor };
}

async function submitSale(
  app: FastifyInstance,
  overrides: Partial<{
    localSaleId: string;
    businessDate: string;
    outletId: string;
    totalIdr: number;
    tenders: ReadonlyArray<{
      method: "cash" | "qris" | "card" | "other";
      amountIdr: number;
      reference: string | null;
    }>;
  }> = {},
) {
  const localSaleId = overrides.localSaleId ?? "01890abc-1234-7def-8000-000000000100";
  const totalIdr = overrides.totalIdr ?? 50_000;
  const tenders = overrides.tenders ?? [
    { method: "cash" as const, amountIdr: totalIdr, reference: null },
  ];
  return app.inject({
    method: "POST",
    url: "/v1/sales/submit",
    headers: { "content-type": "application/json" },
    payload: {
      localSaleId,
      outletId: overrides.outletId ?? OUTLET_ID,
      clerkId: CLERK_ID,
      businessDate: overrides.businessDate ?? "2026-04-23",
      createdAt: "2026-04-23T03:00:00.000Z",
      subtotalIdr: totalIdr,
      discountIdr: 0,
      totalIdr,
      items: [
        {
          itemId: ITEM_ID,
          bomId: null,
          quantity: 1,
          uomId: UOM_ID,
          unitPriceIdr: totalIdr,
          lineTotalIdr: totalIdr,
        },
      ],
      tenders,
    },
  });
}

async function closeEod(
  app: FastifyInstance,
  body: {
    outletId?: string;
    businessDate?: string;
    countedCashIdr: number;
    varianceReason?: string | null;
    clientSaleIds?: readonly string[];
  },
) {
  return app.inject({
    method: "POST",
    url: "/v1/eod/close",
    headers: { "content-type": "application/json" },
    payload: {
      outletId: body.outletId ?? OUTLET_ID,
      businessDate: body.businessDate ?? "2026-04-23",
      countedCashIdr: body.countedCashIdr,
      varianceReason: body.varianceReason ?? null,
      clientSaleIds: body.clientSaleIds ?? [],
    },
  });
}

describe("POST /v1/sales/submit (shim for EOD)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("records a sale so EOD can later reconcile it", async () => {
    const res = await submitSale(h.app);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { name: string };
    expect(body.name).toContain("sale-");
  });

  it("is idempotent on (merchant, localSaleId) — replay returns 409 with the canonical name", async () => {
    const first = await submitSale(h.app);
    expect(first.statusCode).toBe(201);
    const second = await submitSale(h.app);
    expect(second.statusCode).toBe(409);
    const body = second.json() as { name: string };
    expect(body.name).toBe((first.json() as { name: string }).name);
  });
});

describe("POST /v1/eod/close", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("happy path: zero-variance close returns the canonical breakdown", async () => {
    const saleA = "01890abc-1234-7def-8000-000000000101";
    const saleB = "01890abc-1234-7def-8000-000000000102";
    await submitSale(h.app, { localSaleId: saleA, totalIdr: 25_000 });
    await submitSale(h.app, {
      localSaleId: saleB,
      totalIdr: 50_000,
      tenders: [{ method: "qris", amountIdr: 50_000, reference: "ref-qris-1" }],
    });

    const res = await closeEod(h.app, {
      countedCashIdr: 25_000,
      clientSaleIds: [saleA, saleB],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      expectedCashIdr: number;
      varianceIdr: number;
      varianceReason: string | null;
      breakdown: {
        saleCount: number;
        cashIdr: number;
        qrisStaticIdr: number;
        qrisDynamicIdr: number;
        netIdr: number;
      };
    };
    expect(body.expectedCashIdr).toBe(25_000);
    expect(body.varianceIdr).toBe(0);
    expect(body.varianceReason).toBeNull();
    expect(body.breakdown.saleCount).toBe(2);
    expect(body.breakdown.cashIdr).toBe(25_000);
    expect(body.breakdown.qrisStaticIdr).toBe(50_000);
    expect(body.breakdown.qrisDynamicIdr).toBe(0);
    expect(body.breakdown.netIdr).toBe(75_000);
  });

  it("cash-short close records the variance and reason", async () => {
    const saleA = "01890abc-1234-7def-8000-000000000201";
    await submitSale(h.app, { localSaleId: saleA, totalIdr: 100_000 });

    const res = await closeEod(h.app, {
      countedCashIdr: 90_000,
      varianceReason: "kembalian lupa diambil pembeli",
      clientSaleIds: [saleA],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      varianceIdr: number;
      varianceReason: string;
      expectedCashIdr: number;
    };
    expect(body.expectedCashIdr).toBe(100_000);
    expect(body.varianceIdr).toBe(-10_000);
    expect(body.varianceReason).toBe("kembalian lupa diambil pembeli");
  });

  it("rejects a non-zero variance without a reason (422 eod_variance_reason_required)", async () => {
    const saleA = "01890abc-1234-7def-8000-000000000301";
    await submitSale(h.app, { localSaleId: saleA, totalIdr: 50_000 });

    const res = await closeEod(h.app, {
      countedCashIdr: 49_000,
      varianceReason: null,
      clientSaleIds: [saleA],
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("eod_variance_reason_required");
  });

  it("missing-sale guard: client sent an id the server does not have", async () => {
    const known = "01890abc-1234-7def-8000-000000000401";
    const unknown = "01890abc-1234-7def-8000-000000000402";
    await submitSale(h.app, { localSaleId: known, totalIdr: 10_000 });

    const res = await closeEod(h.app, {
      countedCashIdr: 10_000,
      clientSaleIds: [known, unknown],
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: {
        code: string;
        details: { expectedCount: number; receivedCount: number; missingSaleIds: string[] };
      };
    };
    expect(body.error.code).toBe("eod_sale_mismatch");
    expect(body.error.details.expectedCount).toBe(2);
    expect(body.error.details.receivedCount).toBe(1);
    expect(body.error.details.missingSaleIds).toEqual([unknown]);
  });

  it("locks (outlet, businessDate): second close for the same tuple is 409 eod_already_closed", async () => {
    const sale = "01890abc-1234-7def-8000-000000000501";
    await submitSale(h.app, { localSaleId: sale, totalIdr: 10_000 });
    const first = await closeEod(h.app, {
      countedCashIdr: 10_000,
      clientSaleIds: [sale],
    });
    expect(first.statusCode).toBe(201);

    const second = await closeEod(h.app, {
      countedCashIdr: 10_000,
      clientSaleIds: [sale],
    });
    expect(second.statusCode).toBe(409);
    const body = second.json() as { error: { code: string } };
    expect(body.error.code).toBe("eod_already_closed");
  });

  it("accepts a no-sales-day close (empty clientSaleIds)", async () => {
    const res = await closeEod(h.app, { countedCashIdr: 0, clientSaleIds: [] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { varianceIdr: number; breakdown: { saleCount: number } };
    expect(body.varianceIdr).toBe(0);
    expect(body.breakdown.saleCount).toBe(0);
  });

  it("splits mixed-tender sale cash correctly (cash = total − non-cash)", async () => {
    const sale = "01890abc-1234-7def-8000-000000000601";
    await submitSale(h.app, {
      localSaleId: sale,
      totalIdr: 30_000,
      tenders: [
        { method: "qris", amountIdr: 20_000, reference: "ref-split-1" },
        { method: "cash", amountIdr: 10_000, reference: null },
      ],
    });
    const res = await closeEod(h.app, {
      countedCashIdr: 10_000,
      clientSaleIds: [sale],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      breakdown: { cashIdr: number; qrisStaticIdr: number };
      expectedCashIdr: number;
    };
    expect(body.breakdown.cashIdr).toBe(10_000);
    expect(body.breakdown.qrisStaticIdr).toBe(20_000);
    expect(body.expectedCashIdr).toBe(10_000);
  });

  it("rejects a malformed request with 400 bad_request", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/eod/close",
      headers: { "content-type": "application/json" },
      payload: { outletId: "not-a-uuid", businessDate: "nope", countedCashIdr: -1 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });
});

describe("EodService — directly", () => {
  it("skips voided sales when computing the breakdown", async () => {
    const dataPlane = new InMemoryEodDataPlane();
    const service = new EodService({ dataPlane, now: () => CLOCK_NOW });
    const active: SaleRecord = {
      localSaleId: "01890abc-1234-7def-8000-000000000701",
      merchantId: MERCHANT_ID,
      outletId: OUTLET_ID,
      clerkId: CLERK_ID,
      businessDate: "2026-04-23",
      createdAt: "2026-04-23T03:00:00.000Z",
      subtotalIdr: 40_000,
      discountIdr: 0,
      totalIdr: 40_000,
      items: [],
      tenders: [{ method: "cash", amountIdr: 40_000, reference: null }],
      voidedAt: null,
    };
    const voided: SaleRecord = {
      ...active,
      localSaleId: "01890abc-1234-7def-8000-000000000702",
      totalIdr: 15_000,
      tenders: [{ method: "cash", amountIdr: 15_000, reference: null }],
      voidedAt: "2026-04-23T05:00:00.000Z",
    };
    await service.upsertSale(active);
    await service.upsertSale(voided);

    const record = await service.close({
      merchantId: MERCHANT_ID,
      outletId: OUTLET_ID,
      businessDate: "2026-04-23",
      countedCashIdr: 40_000,
      varianceReason: null,
      clientSaleIds: [active.localSaleId, voided.localSaleId],
    });
    expect(record.breakdown.saleCount).toBe(1);
    expect(record.breakdown.voidCount).toBe(1);
    expect(record.breakdown.netIdr).toBe(40_000);
    expect(record.expectedCashIdr).toBe(40_000);
  });
});
