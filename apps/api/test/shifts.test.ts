import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  EodService,
  InMemoryEodRepository,
  SalesRepositorySalesReader,
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
import { InMemoryShiftsRepository, ShiftsService } from "../src/services/shifts/index.js";

const MERCHANT_ID = "01890abc-1234-7def-8000-00000000a001";
const OUTLET_ID = "01890abc-1234-7def-8000-000000000001";
const CASHIER_ID = "01890abc-1234-7def-8000-00000000c001";
const ITEM_ID = "01890abc-1234-7def-8000-000000000b01";
const UOM_ID = "01890abc-1234-7def-8000-000000000b02";
const OPEN_SHIFT_ID = "01890abc-1234-7def-8000-0000000a0001";
const CLOSE_SHIFT_ID = "01890abc-1234-7def-8000-0000000a0002";
const CLOCK_NOW = new Date("2026-04-23T12:00:00+07:00");

interface Harness {
  app: FastifyInstance;
  salesRepository: InMemorySalesRepository;
  shiftsService: ShiftsService;
}

function makeItem(): Item {
  return {
    id: ITEM_ID,
    merchantId: MERCHANT_ID,
    code: "S-FIXED-01",
    name: "Shift fixture item",
    priceIdr: 25_000,
    uomId: UOM_ID,
    bomId: null,
    isStockTracked: false,
    allowNegative: false,
    taxRate: 11,
    isActive: true,
  };
}

function makeOutlet(): Outlet {
  return {
    id: OUTLET_ID,
    merchantId: MERCHANT_ID,
    code: "JKT-S",
    name: "Shift fixture outlet",
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
  const shiftsRepository = new InMemoryShiftsRepository();
  let shiftIdCursor = 0;
  const shiftsService = new ShiftsService({
    repository: shiftsRepository,
    salesReader: new SalesRepositorySalesReader(salesRepository),
    now: () => CLOCK_NOW,
    generateShiftId: () => {
      shiftIdCursor += 1;
      return `01890abc-1234-7def-8000-0000000d000${shiftIdCursor}`;
    },
  });
  const eodRepository = new InMemoryEodRepository();
  const eodService = new EodService({
    salesReader: new SalesRepositorySalesReader(salesRepository),
    eodRepository,
    shiftReader: shiftsRepository,
    now: () => CLOCK_NOW,
    generateEodId: () => "01890abc-1234-7def-8000-0000000eee01",
  });

  const app = await buildApp({
    sales: { service: salesService, repository: salesRepository },
    shifts: { service: shiftsService, repository: shiftsRepository },
    eod: { service: eodService, resolveMerchantId: () => MERCHANT_ID },
    resolveMerchantId: () => MERCHANT_ID,
  });
  await app.ready();
  return { app, salesRepository, shiftsService };
}

let seedCursor = 0;

async function seedCashSale(repository: InMemorySalesRepository, amountIdr: number): Promise<Sale> {
  seedCursor += 1;
  const tenders: SaleTender[] = [{ method: "cash", amountIdr, reference: null }];
  const items: SaleLine[] = [
    {
      itemId: ITEM_ID,
      bomId: null,
      quantity: 1,
      uomId: UOM_ID,
      unitPriceIdr: amountIdr,
      lineTotalIdr: amountIdr,
    },
  ];
  const saleId = `01890abc-1234-7def-8000-${seedCursor.toString(16).padStart(12, "0")}`;
  const sale: Sale = {
    id: saleId,
    merchantId: MERCHANT_ID,
    outletId: OUTLET_ID,
    clerkId: CASHIER_ID,
    localSaleId: `01890abc-1234-7def-8000-100000000${seedCursor.toString().padStart(3, "0")}`,
    name: `SALE-20260423-${seedCursor}`,
    businessDate: "2026-04-23",
    subtotalIdr: amountIdr,
    discountIdr: 0,
    totalIdr: amountIdr,
    taxIdr: 0,
    items,
    tenders,
    createdAt: "2026-04-23T03:00:00.000Z",
    voidedAt: null,
    voidBusinessDate: null,
    voidReason: null,
    localVoidId: null,
    voidedByStaffId: null,
    refunds: [],
    synthetic: false,
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

let h: Harness;
beforeEach(async () => {
  seedCursor = 0;
  h = await setup();
});
afterEach(async () => {
  await h.app.close();
});

describe("POST /v1/shifts/open", () => {
  it("creates a new open shift on first call (201)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/shifts/open",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload: {
        openShiftId: OPEN_SHIFT_ID,
        outletId: OUTLET_ID,
        cashierStaffId: CASHIER_ID,
        businessDate: "2026-04-23",
        openedAt: "2026-04-23T09:00:00.000Z",
        openingFloatIdr: 100_000,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.openShiftId).toBe(OPEN_SHIFT_ID);
    expect(body.openingFloatIdr).toBe(100_000);
    expect(body.status).toBe("open");
    expect(body.closedAt).toBe(null);
  });

  it("is idempotent on (merchantId, openShiftId) (returns 200 + existing row)", async () => {
    const payload = {
      openShiftId: OPEN_SHIFT_ID,
      outletId: OUTLET_ID,
      cashierStaffId: CASHIER_ID,
      businessDate: "2026-04-23",
      openedAt: "2026-04-23T09:00:00.000Z",
      openingFloatIdr: 100_000,
    };
    await h.app.inject({
      method: "POST",
      url: "/v1/shifts/open",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload,
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/shifts/open",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.openShiftId).toBe(OPEN_SHIFT_ID);
  });

  it("rejects a different payload reusing the same openShiftId (409)", async () => {
    const original = {
      openShiftId: OPEN_SHIFT_ID,
      outletId: OUTLET_ID,
      cashierStaffId: CASHIER_ID,
      businessDate: "2026-04-23",
      openedAt: "2026-04-23T09:00:00.000Z",
      openingFloatIdr: 100_000,
    };
    await h.app.inject({
      method: "POST",
      url: "/v1/shifts/open",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload: original,
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/shifts/open",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload: { ...original, openingFloatIdr: 50_000 },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("shift_idempotency_conflict");
  });
});

describe("POST /v1/shifts/close", () => {
  async function openOnce(): Promise<void> {
    await h.app.inject({
      method: "POST",
      url: "/v1/shifts/open",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload: {
        openShiftId: OPEN_SHIFT_ID,
        outletId: OUTLET_ID,
        cashierStaffId: CASHIER_ID,
        businessDate: "2026-04-23",
        openedAt: "2026-04-23T09:00:00.000Z",
        openingFloatIdr: 100_000,
      },
    });
  }

  it("derives expectedCash = float + cashSales and computes variance", async () => {
    await openOnce();
    // Three cash sales totalling Rp 75,000 (per KASA-235 acceptance).
    await seedCashSale(h.salesRepository, 25_000);
    await seedCashSale(h.salesRepository, 25_000);
    await seedCashSale(h.salesRepository, 25_000);

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/shifts/close",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload: {
        closeShiftId: CLOSE_SHIFT_ID,
        openShiftId: OPEN_SHIFT_ID,
        closedAt: "2026-04-23T17:00:00.000Z",
        countedCashIdr: 175_000,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.expectedCashIdr).toBe(175_000);
    expect(body.varianceIdr).toBe(0);
    expect(body.status).toBe("closed");
    expect(body.closedAt).toBe("2026-04-23T17:00:00.000Z");
  });

  it("surfaces a negative variance when counted is short", async () => {
    await openOnce();
    await seedCashSale(h.salesRepository, 25_000);
    await seedCashSale(h.salesRepository, 25_000);
    await seedCashSale(h.salesRepository, 25_000);

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/shifts/close",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload: {
        closeShiftId: CLOSE_SHIFT_ID,
        openShiftId: OPEN_SHIFT_ID,
        closedAt: "2026-04-23T17:00:00.000Z",
        countedCashIdr: 174_000,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.varianceIdr).toBe(-1_000);
  });

  it("is idempotent on closeShiftId — replay returns the same closed row", async () => {
    await openOnce();
    const payload = {
      closeShiftId: CLOSE_SHIFT_ID,
      openShiftId: OPEN_SHIFT_ID,
      closedAt: "2026-04-23T17:00:00.000Z",
      countedCashIdr: 100_000,
    };
    const first = await h.app.inject({
      method: "POST",
      url: "/v1/shifts/close",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload,
    });
    expect(first.statusCode).toBe(200);
    const replay = await h.app.inject({
      method: "POST",
      url: "/v1/shifts/close",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
  });

  it("404s when the openShiftId is unknown", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/shifts/close",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload: {
        closeShiftId: CLOSE_SHIFT_ID,
        openShiftId: "01890abc-1234-7def-8000-0000000aaaa1",
        closedAt: "2026-04-23T17:00:00.000Z",
        countedCashIdr: 100_000,
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("shift_not_found");
  });
});

describe("GET /v1/shifts/current", () => {
  it("404s when no open shift exists", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/shifts/current?outletId=${OUTLET_ID}&cashierStaffId=${CASHIER_ID}`,
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns the open shift when one exists", async () => {
    await h.app.inject({
      method: "POST",
      url: "/v1/shifts/open",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload: {
        openShiftId: OPEN_SHIFT_ID,
        outletId: OUTLET_ID,
        cashierStaffId: CASHIER_ID,
        businessDate: "2026-04-23",
        openedAt: "2026-04-23T09:00:00.000Z",
        openingFloatIdr: 100_000,
      },
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/shifts/current?outletId=${OUTLET_ID}&cashierStaffId=${CASHIER_ID}`,
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.openShiftId).toBe(OPEN_SHIFT_ID);
  });
});

describe("EOD close folds the opening float into expected cash", () => {
  it("expectedCashIdr = openingFloatIdr + cashSales (KASA-235 AC)", async () => {
    // Open a shift with a Rp 100,000 float, ring three Rp 25,000 cash
    // sales, close EOD: expectedCash should be Rp 175,000 (mirrors the
    // shift-close calculation), variance zero on Rp 175,000 counted.
    await h.app.inject({
      method: "POST",
      url: "/v1/shifts/open",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload: {
        openShiftId: OPEN_SHIFT_ID,
        outletId: OUTLET_ID,
        cashierStaffId: CASHIER_ID,
        businessDate: "2026-04-23",
        openedAt: "2026-04-23T09:00:00.000Z",
        openingFloatIdr: 100_000,
      },
    });
    const sale1 = await seedCashSale(h.salesRepository, 25_000);
    const sale2 = await seedCashSale(h.salesRepository, 25_000);
    const sale3 = await seedCashSale(h.salesRepository, 25_000);

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/eod/close",
      headers: { "x-kassa-merchant-id": MERCHANT_ID },
      payload: {
        outletId: OUTLET_ID,
        businessDate: "2026-04-23",
        countedCashIdr: 175_000,
        varianceReason: null,
        clientSaleIds: [sale1.localSaleId, sale2.localSaleId, sale3.localSaleId],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.openingFloatIdr).toBe(100_000);
    expect(body.expectedCashIdr).toBe(175_000);
    expect(body.varianceIdr).toBe(0);
  });
});
