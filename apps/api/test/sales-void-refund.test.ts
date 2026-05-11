import argon2 from "argon2";
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
import { InMemoryShiftsRepository } from "../src/services/shifts/index.js";
import { InMemoryStaffRepository } from "../src/services/staff/index.js";

/*
 * Contract tests for POST /v1/sales/:saleId/void and /refund (KASA-122 PR2,
 * extended for KASA-236-A's manager-PIN + open-shift gates).
 *
 * Each test starts with a freshly seeded merchant + outlets + items + BOMs,
 * submits one canonical "Kopi Susu × 2" sale (cash 50_000), seeds a manager
 * staff row with a known PIN, and opens a shift on the sale's business date
 * so the void/refund cases have a real saleId + ledger to mirror.
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

const MANAGER_STAFF_ID = "77777777-7777-7777-8777-777777777701";
const CASHIER_STAFF_ID = "77777777-7777-7777-8777-777777777702";
const OTHER_MANAGER_STAFF_ID = "77777777-7777-7777-8777-777777777703";
const MANAGER_PIN = "1234";
const CASHIER_PIN = "9999";

const OPEN_SHIFT_ID = "88888888-8888-7888-8888-888888888801";
const LOCAL_VOID_ID = "01929d00-0001-7000-8000-000000000001";
const SECONDARY_LOCAL_VOID_ID = "01929d00-0001-7000-8000-000000000002";

interface Fixture {
  app: FastifyInstance;
  repository: InMemorySalesRepository;
  shifts: InMemoryShiftsRepository;
  saleId: string;
}

function voidPayload(overrides: Record<string, unknown> = {}) {
  return {
    localVoidId: LOCAL_VOID_ID,
    managerStaffId: MANAGER_STAFF_ID,
    managerPin: MANAGER_PIN,
    voidedAt: "2026-04-24T09:00:00+07:00",
    voidBusinessDate: "2026-04-24",
    ...overrides,
  };
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
      taxRate: 11,
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
      taxRate: 11,
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
      taxRate: 11,
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
      taxRate: 11,
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
      taxRate: 11,
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

  // KASA-236-A — seed a manager (owner) + cashier so the void route's PIN
  // gate has real argon2 hashes to verify against, plus an "other manager"
  // belonging to a different merchant for the cross-tenant rejection case.
  const staff = new InMemoryStaffRepository();
  const managerPinHash = await argon2.hash(MANAGER_PIN, { type: argon2.argon2id });
  const cashierPinHash = await argon2.hash(CASHIER_PIN, { type: argon2.argon2id });
  staff.seedStaff({
    id: MANAGER_STAFF_ID,
    merchantId: MERCHANT,
    email: "manager@example.com",
    passwordHash: "unused",
    displayName: "Manajer",
    role: "manager",
    pinHash: managerPinHash,
  });
  staff.seedStaff({
    id: CASHIER_STAFF_ID,
    merchantId: MERCHANT,
    email: "cashier@example.com",
    passwordHash: "unused",
    displayName: "Kasir",
    role: "cashier",
    pinHash: cashierPinHash,
  });
  staff.seedStaff({
    id: OTHER_MANAGER_STAFF_ID,
    merchantId: OTHER_MERCHANT,
    email: "other-manager@example.com",
    passwordHash: "unused",
    displayName: "Manajer Lain",
    role: "manager",
    pinHash: managerPinHash,
  });

  // KASA-236-A — open shift on the sale's business date so the void route's
  // open-shift gate passes for the happy path. Tests that want the
  // negative gate close the shift or skip seeding via the dedicated helper.
  const shifts = new InMemoryShiftsRepository();
  await shifts.insertOpen({
    id: "018f3333-3333-7333-8333-000000000001",
    merchantId: MERCHANT,
    outletId: OUTLET,
    cashierStaffId: CASHIER_STAFF_ID,
    businessDate: "2026-04-24",
    status: "open",
    openShiftId: OPEN_SHIFT_ID,
    openedAt: "2026-04-24T08:00:00+07:00",
    openingFloatIdr: 0,
    closeShiftId: null,
    closedAt: null,
    countedCashIdr: null,
    expectedCashIdr: null,
    varianceIdr: null,
  });

  let serviceCursor = 0;
  const serviceIdGen = () => {
    serviceCursor += 1;
    return `018f1111-1111-7111-8111-${(serviceCursor + 0x1000).toString(16).padStart(12, "0")}`;
  };
  const service = new SalesService({
    repository,
    openShiftReader: shifts,
    managerPinReader: {
      async findStaffById(input) {
        const row = await staff.findById(input);
        if (!row) return null;
        return { id: row.id, merchantId: row.merchantId, role: row.role, pinHash: row.pinHash };
      },
    },
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
  return { app, repository, shifts, saleId };
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
      payload: voidPayload(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("returns 422 validation_error for a missing voidedAt", async () => {
    const { voidedAt: _omit, ...partial } = voidPayload();
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: partial,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns 422 validation_error for a non-UUIDv7 saleId param", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/not-a-uuid/void",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: voidPayload(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns 404 sale_not_found for a sale that does not exist", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/018f1111-1111-7111-8111-000000999999/void",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: voidPayload(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "sale_not_found" } });
  });

  it("returns 403 void_requires_manager when managerStaffId belongs to a different merchant", async () => {
    // Caller's merchant is MERCHANT, but the manager id is bound to
    // OTHER_MERCHANT. `findStaffById` gates on (merchantId, staffId) so
    // the cross-tenant id resolves to null and the PIN gate fails ahead
    // of any sale lookup — the response has no way to leak whether the
    // sale exists.
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: voidPayload({ managerStaffId: OTHER_MANAGER_STAFF_ID }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "void_requires_manager" } });
  });

  it("voids a sale, mirroring the original ledger with positive sale_void rows", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: voidPayload({ reason: "wrong cup" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      saleId: string;
      localVoidId: string;
      voidedAt: string;
      voidBusinessDate: string;
      reason: string | null;
      ledger: { itemId: string; delta: number; reason: string; refType: string; refId: string }[];
    };
    expect(body.saleId).toBe(fixture.saleId);
    expect(body.localVoidId).toBe(LOCAL_VOID_ID);
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
    const first = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: voidPayload({ reason: "wrong cup" }),
    });
    expect(first.statusCode).toBe(201);

    // Replay with a different `localVoidId` AND a different `voidedAt` —
    // the sale.voidedAt short-circuit means we still get 200 with the
    // originally stamped values back, never a double-balanced ledger.
    const second = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: voidPayload({
        localVoidId: SECONDARY_LOCAL_VOID_ID,
        voidedAt: "2026-04-24T10:00:00+07:00",
        reason: "wrong cup",
      }),
    });
    expect(second.statusCode).toBe(200);
    const body = second.json() as { localVoidId: string; voidedAt: string; ledger: unknown[] };
    // Server keeps the originally stamped voidedAt + localVoidId; replay is a read.
    expect(body.voidedAt).toBe("2026-04-24T09:00:00+07:00");
    expect(body.localVoidId).toBe(LOCAL_VOID_ID);
    expect(body.ledger).toEqual([]);

    // No double balancing — only the original three sale_void entries exist.
    const ledger = fixture.repository._peekLedger();
    const voidEntries = ledger.filter((row) => row.reason === "sale_void");
    expect(voidEntries).toHaveLength(3);
  });

  it("returns 403 void_requires_manager when the role is cashier", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: voidPayload({ managerStaffId: CASHIER_STAFF_ID, managerPin: CASHIER_PIN }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "void_requires_manager" } });
  });

  it("returns 403 void_requires_manager when the manager PIN is wrong", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: voidPayload({ managerPin: "0000" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "void_requires_manager" } });
  });

  it("returns 403 void_requires_manager when the managerStaffId is unknown", async () => {
    const res = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: voidPayload({ managerStaffId: "77777777-7777-7777-8777-7777777777ff" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "void_requires_manager" } });
  });

  it("returns 422 void_outside_open_shift when the sale's outlet has no open shift", async () => {
    // Build a separate fixture where no open shift is seeded. The PIN
    // gate still passes; the shift gate is the only thing that fails.
    const f = await buildFixtureWithoutOpenShift();
    try {
      const res = await f.app.inject({
        method: "POST",
        url: `/v1/sales/${f.saleId}/void`,
        headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
        payload: voidPayload(),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: "void_outside_open_shift" } });
    } finally {
      await f.app.close();
    }
  });

  it("returns 422 void_outside_open_shift when sale.businessDate does not match the open shift's businessDate", async () => {
    // Seeded sale is on 2026-04-24. Build a fresh fixture with an open
    // shift on a different business date so the cross-shift case fires.
    const f = await buildFixtureWithCrossDayShift();
    try {
      const res = await f.app.inject({
        method: "POST",
        url: `/v1/sales/${f.saleId}/void`,
        headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
        payload: voidPayload(),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: "void_outside_open_shift" } });
    } finally {
      await f.app.close();
    }
  });

  it("returns 409 void_idempotency_conflict when the same localVoidId targets a different sale", async () => {
    // Submit a second sale so we have two saleIds to test against.
    const secondSubmit = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: kopiPayload("01929b2d-1e01-7f00-80aa-000000000002", 2),
    });
    expect(secondSubmit.statusCode).toBe(201);
    const secondSaleId = (secondSubmit.json() as { saleId: string }).saleId;

    // First void on sale #1 with LOCAL_VOID_ID.
    const first = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${fixture.saleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: voidPayload(),
    });
    expect(first.statusCode).toBe(201);

    // Reuse LOCAL_VOID_ID against sale #2 → 409.
    const second = await fixture.app.inject({
      method: "POST",
      url: `/v1/sales/${secondSaleId}/void`,
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: voidPayload(),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "void_idempotency_conflict" } });
  });
});

async function buildFixtureWithoutOpenShift(): Promise<Fixture> {
  const f = await buildFixture();
  // Drop the seeded shift so the open-shift gate fails. The in-memory
  // shifts repo doesn't expose a delete, so we close it via recordClose.
  await f.shifts.recordClose({
    merchantId: MERCHANT,
    openShiftId: OPEN_SHIFT_ID,
    closeShiftId: "88888888-8888-7888-8888-888888888899",
    closedAt: "2026-04-24T20:00:00+07:00",
    countedCashIdr: 50_000,
    expectedCashIdr: 50_000,
    varianceIdr: 0,
  });
  return f;
}

async function buildFixtureWithCrossDayShift(): Promise<Fixture> {
  const f = await buildFixture();
  // Close the same-day shift and open a new one on a different day so the
  // (merchant, outlet) has an open shift but its businessDate does not
  // match the sale's. The seeded sale is on 2026-04-24.
  await f.shifts.recordClose({
    merchantId: MERCHANT,
    openShiftId: OPEN_SHIFT_ID,
    closeShiftId: "88888888-8888-7888-8888-888888888899",
    closedAt: "2026-04-24T20:00:00+07:00",
    countedCashIdr: 50_000,
    expectedCashIdr: 50_000,
    varianceIdr: 0,
  });
  await f.shifts.insertOpen({
    id: "018f3333-3333-7333-8333-000000000002",
    merchantId: MERCHANT,
    outletId: OUTLET,
    cashierStaffId: CASHIER_STAFF_ID,
    businessDate: "2026-04-25",
    status: "open",
    openShiftId: "88888888-8888-7888-8888-888888888802",
    openedAt: "2026-04-25T08:00:00+07:00",
    openingFloatIdr: 0,
    closeShiftId: null,
    closedAt: null,
    countedCashIdr: null,
    expectedCashIdr: null,
    varianceIdr: null,
  });
  return f;
}

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
      payload: voidPayload(),
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
      payload: voidPayload({ voidedAt: "2026-04-24T10:00:00+07:00" }),
    });
    expect(voidRes.statusCode).toBe(422);
    expect(voidRes.json()).toMatchObject({ error: { code: "sale_has_refunds" } });
  });
});
