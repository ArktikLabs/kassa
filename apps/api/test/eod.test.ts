import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  EodService,
  InMemoryEodRepository,
  SalesRepositorySalesReader,
  type SaleRecord,
  type SalesReader,
} from "../src/services/eod/index.js";
import {
  InMemorySalesRepository,
  SalesService,
  type Item,
  type Outlet,
  type Sale,
  type SaleLine,
  type SaleTender,
} from "../src/services/sales/index.js";

const MERCHANT_ID = "01890abc-1234-7def-8000-00000000a001";
const OUTLET_ID = "01890abc-1234-7def-8000-000000000001";
const CLERK_ID = "01890abc-1234-7def-8000-00000000c001";
const ITEM_ID = "01890abc-1234-7def-8000-000000000b01";
const UOM_ID = "01890abc-1234-7def-8000-000000000b02";
const CLOCK_NOW = new Date("2026-04-23T12:00:00+07:00");

interface Harness {
  app: FastifyInstance;
  salesRepository: InMemorySalesRepository;
  service: EodService;
}

function makeItem(): Item {
  // Non-stock-tracked / non-BOM finished good — keeps the EOD fixture minimal:
  // the SalesService records the sale row without any ledger movement, so we
  // do not need to seed any catalog stock here. The full BOM/stock paths are
  // covered in apps/api/test/sales.test.ts.
  return {
    id: ITEM_ID,
    merchantId: MERCHANT_ID,
    code: "EOD-FIXED-01",
    name: "EOD fixture item",
    priceIdr: 25_000,
    uomId: UOM_ID,
    bomId: null,
    isStockTracked: false,
    allowNegative: false,
    isActive: true,
  };
}

function makeOutlet(): Outlet {
  return {
    id: OUTLET_ID,
    merchantId: MERCHANT_ID,
    code: "JKT-EOD",
    name: "EOD fixture outlet",
    timezone: "Asia/Jakarta",
  };
}

async function setup(): Promise<Harness> {
  const salesRepository = new InMemorySalesRepository();
  salesRepository.seedItems([makeItem()]);
  salesRepository.seedOutlets([makeOutlet()]);
  let salesIdCursor = 0;
  const salesIdGen = () => {
    salesIdCursor += 1;
    const hex = salesIdCursor.toString(16).padStart(12, "0");
    return `01890abc-1234-7def-8000-${hex}`;
  };
  const salesService = new SalesService({
    repository: salesRepository,
    generateId: salesIdGen,
    now: () => CLOCK_NOW,
  });

  const eodRepository = new InMemoryEodRepository();
  const salesReader = new SalesRepositorySalesReader(salesRepository);
  let eodIdCursor = 0;
  const service = new EodService({
    salesReader,
    eodRepository,
    now: () => CLOCK_NOW,
    generateEodId: () => {
      eodIdCursor += 1;
      return `01890abc-1234-7def-8000-0000000eee0${eodIdCursor}`;
    },
  });

  const app = await buildApp({
    sales: { service: salesService, repository: salesRepository },
    eod: { service, resolveMerchantId: () => MERCHANT_ID },
  });
  await app.ready();
  return { app, salesRepository, service };
}

interface SeedSaleOverrides {
  localSaleId?: string;
  outletId?: string;
  businessDate?: string;
  totalIdr?: number;
  tenders?: readonly SaleTender[];
  createdAt?: string;
}

let seedSaleCursor = 0;

/**
 * Seed a sale directly into the shared SalesRepository — bypasses the BOM /
 * stock-guard machinery in SalesService so EOD tests can construct sale rows
 * without registering catalog items + on-hand ledger entries. This is the
 * only place EOD tests touch persistence directly; the canonical
 * /v1/sales/submit path is exercised in sales.test.ts and once below.
 */
async function seedSale(
  repository: InMemorySalesRepository,
  overrides: SeedSaleOverrides = {},
): Promise<Sale> {
  seedSaleCursor += 1;
  const totalIdr = overrides.totalIdr ?? 50_000;
  const tenders: SaleTender[] = (
    overrides.tenders ?? [{ method: "cash", amountIdr: totalIdr, reference: null }]
  ).map((tender) => ({ ...tender }));
  const items: SaleLine[] = [
    {
      itemId: ITEM_ID,
      bomId: null,
      quantity: 1,
      uomId: UOM_ID,
      unitPriceIdr: totalIdr,
      lineTotalIdr: totalIdr,
    },
  ];
  const saleId = `01890abc-1234-7def-8000-${seedSaleCursor.toString(16).padStart(12, "0")}`;
  const sale: Sale = {
    id: saleId,
    merchantId: MERCHANT_ID,
    outletId: overrides.outletId ?? OUTLET_ID,
    clerkId: CLERK_ID,
    localSaleId: overrides.localSaleId ?? "01890abc-1234-7def-8000-000000000100",
    name: `SALE-${(overrides.businessDate ?? "2026-04-23").replaceAll("-", "")}-${saleId.slice(-4)}`,
    businessDate: overrides.businessDate ?? "2026-04-23",
    subtotalIdr: totalIdr,
    discountIdr: 0,
    totalIdr,
    items,
    tenders,
    createdAt: overrides.createdAt ?? "2026-04-23T03:00:00.000Z",
    voidedAt: null,
    voidBusinessDate: null,
    voidReason: null,
    refunds: [],
  };
  let ledgerCursor = 0;
  const persisted = await repository.recordSale({
    sale,
    ledger: [],
    idGenerator: () => {
      ledgerCursor += 1;
      return `01890abc-1234-7def-8000-fff${ledgerCursor.toString(16).padStart(9, "0")}`;
    },
  });
  return persisted.sale;
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

describe("EOD/Sales integration (KASA-65 ↔ KASA-66)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("a sale submitted via POST /v1/sales/submit is reconciled by EOD close", async () => {
    const localSaleId = "01890abc-1234-7def-8000-000000000800";
    const submit = await h.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: {
        "content-type": "application/json",
        "x-kassa-merchant-id": MERCHANT_ID,
      },
      payload: {
        localSaleId,
        outletId: OUTLET_ID,
        clerkId: CLERK_ID,
        businessDate: "2026-04-23",
        createdAt: "2026-04-23T03:00:00.000Z",
        subtotalIdr: 25_000,
        discountIdr: 0,
        totalIdr: 25_000,
        items: [
          {
            itemId: ITEM_ID,
            bomId: null,
            quantity: 1,
            uomId: UOM_ID,
            unitPriceIdr: 25_000,
            lineTotalIdr: 25_000,
          },
        ],
        tenders: [{ method: "cash", amountIdr: 25_000, reference: null }],
      },
    });
    expect(submit.statusCode).toBe(201);

    const close = await closeEod(h.app, {
      countedCashIdr: 25_000,
      clientSaleIds: [localSaleId],
    });
    expect(close.statusCode).toBe(201);
    const body = close.json() as {
      breakdown: { saleCount: number; cashIdr: number };
      expectedCashIdr: number;
    };
    expect(body.breakdown.saleCount).toBe(1);
    expect(body.breakdown.cashIdr).toBe(25_000);
    expect(body.expectedCashIdr).toBe(25_000);
  });

  it("translates wire `qris` to the unverified `qris_static` bucket on the EOD side", async () => {
    const localSaleId = "01890abc-1234-7def-8000-000000000801";
    await seedSale(h.salesRepository, {
      localSaleId,
      totalIdr: 50_000,
      tenders: [{ method: "qris", amountIdr: 50_000, reference: "ref-qris-translate" }],
    });
    const res = await closeEod(h.app, {
      countedCashIdr: 0,
      clientSaleIds: [localSaleId],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      breakdown: {
        qrisStaticIdr: number;
        qrisStaticUnverifiedIdr: number;
        qrisDynamicIdr: number;
      };
    };
    expect(body.breakdown.qrisStaticIdr).toBe(50_000);
    // Until reconciliation runs, every wire `qris` lands as unverified —
    // the variance report must surface that as the at-risk number.
    expect(body.breakdown.qrisStaticUnverifiedIdr).toBe(50_000);
    expect(body.breakdown.qrisDynamicIdr).toBe(0);
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
    await seedSale(h.salesRepository, { localSaleId: saleA, totalIdr: 25_000 });
    await seedSale(h.salesRepository, {
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
    await seedSale(h.salesRepository, { localSaleId: saleA, totalIdr: 100_000 });

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
    await seedSale(h.salesRepository, { localSaleId: saleA, totalIdr: 50_000 });

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
    await seedSale(h.salesRepository, { localSaleId: known, totalIdr: 10_000 });

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
    await seedSale(h.salesRepository, { localSaleId: sale, totalIdr: 10_000 });
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
    await seedSale(h.salesRepository, {
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

  it("rejects a malformed request with 422 validation_error", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/eod/close",
      headers: { "content-type": "application/json" },
      payload: { outletId: "not-a-uuid", businessDate: "nope", countedCashIdr: -1 },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as {
      error: { code: string; details: { issues: Array<{ source: string; path: string }> } };
    };
    expect(body.error.code).toBe("validation_error");
    const paths = body.error.details.issues.map((i) => `${i.source}:${i.path}`);
    expect(paths).toContain("body:outletId");
    expect(paths).toContain("body:businessDate");
    expect(paths).toContain("body:countedCashIdr");
  });
});

describe("EodService — directly", () => {
  it("skips voided sales when computing the breakdown", async () => {
    // Voids don't exist in the canonical KASA-66 Sale shape yet (KASA-69/70
    // own that surface), so we plug a fake SalesReader that returns hand-
    // crafted SaleRecord rows including a voided one.
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
      tenders: [{ method: "cash", amountIdr: 40_000, reference: null, verified: true }],
      voidedAt: null,
    };
    const voided: SaleRecord = {
      ...active,
      localSaleId: "01890abc-1234-7def-8000-000000000702",
      totalIdr: 15_000,
      tenders: [{ method: "cash", amountIdr: 15_000, reference: null, verified: true }],
      voidedAt: "2026-04-23T05:00:00.000Z",
    };
    const salesReader: SalesReader = {
      async listSalesByBusinessDate() {
        return [active, voided];
      },
    };
    const service = new EodService({
      salesReader,
      eodRepository: new InMemoryEodRepository(),
      now: () => CLOCK_NOW,
    });

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
