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
 * Contract tests for the read-side stock ledger (KASA-122 PR4):
 *
 *   GET /v1/stock/ledger?outletId=&updatedAfter=&pageToken=&limit=
 *
 * The acceptance suite (KASA-68) reads this after the offline outbox drains
 * to assert "correct BOM deductions in Stock Ledger". Every sale, void, and
 * refund writes one row per exploded BOM component with a signed `delta`.
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

interface LedgerEntry {
  id: string;
  outletId: string;
  itemId: string;
  delta: number;
  reason: string;
  refType: string | null;
  refId: string | null;
  occurredAt: string;
}

interface LedgerEnvelope {
  records: LedgerEntry[];
  nextCursor: string | null;
  nextPageToken: string | null;
}

interface Fixture {
  app: FastifyInstance;
  repository: InMemorySalesRepository;
  saleA1: string;
  saleA2: string;
  saleB1: string;
}

function kopiPayload(
  localSaleId: string,
  outletId: string,
  businessDate: string,
  createdAt: string,
  quantity = 2,
) {
  const subtotal = 25_000 * quantity;
  return {
    localSaleId,
    outletId,
    clerkId: "clerk-1",
    businessDate,
    createdAt,
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
      allowNegative: true,
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
      allowNegative: true,
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

  // Per-test deterministic id generator — sorted by issuance order.
  let idCursor = 0;
  const idGen = () => {
    idCursor += 1;
    return `018f1111-1111-7111-8111-${(idCursor + 0x1000).toString(16).padStart(12, "0")}`;
  };
  // Submit-time ledger rows pin `occurredAt` to the server's `now()` (POS
  // clock is not authoritative for sale-time inventory movements), so we
  // advance the clock one minute per call to give each sale a distinct
  // timestamp. That way ordering and updatedAfter assertions don't all
  // collapse onto a single instant.
  let clockMs = Date.parse("2026-04-24T01:30:00.000Z");
  const advancingNow = () => {
    const stamp = new Date(clockMs);
    clockMs += 60_000;
    return stamp;
  };
  const service = new SalesService({
    repository,
    generateId: idGen,
    now: advancingNow,
    generateSaleName: (sale) =>
      `SALE-${sale.businessDate.replaceAll("-", "")}-${sale.id.slice(-4)}`,
  });
  const app = await buildApp({
    sales: { service, repository },
  });
  await app.ready();

  // Two sales on outlet A at distinct timestamps, one on outlet B (must not
  // appear in outlet A's bucket). Each sale explodes BOM_COFFEE into 3 ledger
  // rows (beans + milk + water).
  const a1 = await app.inject({
    method: "POST",
    url: "/v1/sales/submit",
    headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
    payload: kopiPayload(
      "01929b2d-1e01-7f00-80aa-000000000001",
      OUTLET_A,
      "2026-04-24",
      "2026-04-24T08:30:00+07:00",
      2,
    ),
  });
  if (a1.statusCode !== 201) throw new Error(`a1 failed: ${a1.statusCode} ${a1.body}`);
  const a2 = await app.inject({
    method: "POST",
    url: "/v1/sales/submit",
    headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
    payload: kopiPayload(
      "01929b2d-1e01-7f00-80aa-000000000002",
      OUTLET_A,
      "2026-04-24",
      "2026-04-24T08:31:00+07:00",
      1,
    ),
  });
  if (a2.statusCode !== 201) throw new Error(`a2 failed: ${a2.statusCode} ${a2.body}`);
  const b1 = await app.inject({
    method: "POST",
    url: "/v1/sales/submit",
    headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
    payload: kopiPayload(
      "01929b2d-1e01-7f00-80aa-000000000003",
      OUTLET_B,
      "2026-04-24",
      "2026-04-24T08:32:00+07:00",
      3,
    ),
  });
  if (b1.statusCode !== 201) throw new Error(`b1 failed: ${b1.statusCode} ${b1.body}`);

  return {
    app,
    repository,
    saleA1: (a1.json() as { saleId: string }).saleId,
    saleA2: (a2.json() as { saleId: string }).saleId,
    saleB1: (b1.json() as { saleId: string }).saleId,
  };
}

describe("GET /v1/stock/ledger — auth and validation", () => {
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
      url: `/v1/stock/ledger?outletId=${OUTLET_A}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("returns 422 validation_error when outletId is missing", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: "/v1/stock/ledger",
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns 422 validation_error for a non-UUIDv7 outletId", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: "/v1/stock/ledger?outletId=not-a-uuid",
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns 422 validation_error for unknown query keys", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/stock/ledger?outletId=${OUTLET_A}&bogus=1`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns 422 validation_error for non-ISO updatedAfter", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/stock/ledger?outletId=${OUTLET_A}&updatedAfter=yesterday`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns 400 invalid_page_token for a tampered pageToken", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/stock/ledger?outletId=${OUTLET_A}&pageToken=not-base64url-shape`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_page_token" } });
  });
});

describe("GET /v1/stock/ledger — happy path + ordering + tenant isolation", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await buildFixture();
  });
  afterAll(async () => {
    await fixture.app.close();
  });

  it("returns the bucket for outlet A with one row per exploded component", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/stock/ledger?outletId=${OUTLET_A}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LedgerEnvelope;
    // 2 sales × 3 BOM components each = 6 rows; the third sale is on
    // outlet B and must not appear here.
    expect(body.records).toHaveLength(6);
    expect(body.nextPageToken).toBeNull();
    expect(body.nextCursor).not.toBeNull();
    // All rows belong to outlet A and reference one of the two sales.
    for (const row of body.records) {
      expect(row.outletId).toBe(OUTLET_A);
      expect(row.reason).toBe("sale");
      expect(row.refType).toBe("sale");
      expect([fixture.saleA1, fixture.saleA2]).toContain(row.refId);
      expect(row.delta).toBeLessThan(0);
    }
  });

  it("orders rows by (occurredAt ASC, id ASC)", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/stock/ledger?outletId=${OUTLET_A}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LedgerEnvelope;
    for (let i = 1; i < body.records.length; i += 1) {
      const prev = body.records[i - 1];
      const curr = body.records[i];
      if (!prev || !curr) throw new Error("unexpected gap in ledger response");
      const prevAt = Date.parse(prev.occurredAt);
      const currAt = Date.parse(curr.occurredAt);
      expect(prevAt <= currAt).toBe(true);
      if (prevAt === currAt) {
        expect(prev.id < curr.id).toBe(true);
      }
    }
  });

  it("returns an empty bucket for an outlet with no ledger rows", async () => {
    // OUTLET_A has rows; pull a different outlet that exists for this tenant
    // but has no sales — swap to outlet B's tenant + use OUTLET_A's id with a
    // fresh outlet that has no activity. We use the existing OUTLET_B which
    // has one sale, so to test the empty-bucket case we add a third outlet.
    const EMPTY_OUTLET = "22222222-2222-7222-8222-222222222299";
    fixture.repository.seedOutlets([
      {
        id: EMPTY_OUTLET,
        merchantId: MERCHANT,
        code: "JKT-03",
        name: "Jakarta Timur",
        timezone: "Asia/Jakarta",
      },
    ]);
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/stock/ledger?outletId=${EMPTY_OUTLET}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LedgerEnvelope;
    expect(body.records).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.nextPageToken).toBeNull();
  });

  it("returns an empty bucket when the outletId belongs to another merchant", async () => {
    // Cross-tenant probe: the outlet exists for MERCHANT but a request from
    // OTHER_MERCHANT must look indistinguishable from a genuinely empty
    // outlet. No existence leak across merchants.
    const res = await fixture.app.inject({
      method: "GET",
      url: `/v1/stock/ledger?outletId=${OUTLET_A}`,
      headers: { "x-kassa-merchant-id": OTHER_MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LedgerEnvelope;
    expect(body.records).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.nextPageToken).toBeNull();
  });

  it("returns an empty bucket for a non-existent outletId", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: "/v1/stock/ledger?outletId=22222222-2222-7222-8222-222222222999",
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LedgerEnvelope;
    expect(body.records).toEqual([]);
  });

  it("filters out rows at or before updatedAfter", async () => {
    // Pull the full bucket first to find the second-to-last row's occurredAt.
    const all = await fixture.app.inject({
      method: "GET",
      url: `/v1/stock/ledger?outletId=${OUTLET_A}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    const allBody = all.json() as LedgerEnvelope;
    expect(allBody.records.length).toBe(6);

    // saleA1 was at 08:30:00+07:00, saleA2 at 08:31:00+07:00. Pulling with
    // updatedAfter = saleA1's createdAt should leave only saleA2's 3 rows.
    const cutoff = "2026-04-24T08:30:00+07:00";
    const filtered = await fixture.app.inject({
      method: "GET",
      url: `/v1/stock/ledger?outletId=${OUTLET_A}&updatedAfter=${encodeURIComponent(cutoff)}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(filtered.statusCode).toBe(200);
    const body = filtered.json() as LedgerEnvelope;
    expect(body.records).toHaveLength(3);
    for (const row of body.records) {
      expect(row.refId).toBe(fixture.saleA2);
    }
  });
});

describe("GET /v1/stock/ledger — pagination", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await buildFixture();
  });
  afterAll(async () => {
    await fixture.app.close();
  });

  it("paginates with limit + pageToken round-trip and emits nextCursor on the final window", async () => {
    // 6 rows total; limit=4 → first window has 4 rows + nextPageToken,
    // null nextCursor; second window has the remaining 2 rows + null
    // nextPageToken + the bucket's final occurredAt as nextCursor.
    const first = await fixture.app.inject({
      method: "GET",
      url: `/v1/stock/ledger?outletId=${OUTLET_A}&limit=4`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as LedgerEnvelope;
    expect(firstBody.records).toHaveLength(4);
    expect(firstBody.nextPageToken).not.toBeNull();
    expect(firstBody.nextCursor).toBeNull();

    const token = firstBody.nextPageToken;
    if (!token) throw new Error("expected nextPageToken on first window");
    const second = await fixture.app.inject({
      method: "GET",
      url: `/v1/stock/ledger?outletId=${OUTLET_A}&pageToken=${encodeURIComponent(token)}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as LedgerEnvelope;
    expect(secondBody.records).toHaveLength(2);
    expect(secondBody.nextPageToken).toBeNull();
    expect(secondBody.nextCursor).not.toBeNull();

    // The two windows together cover the full bucket exactly once.
    const seen = new Set<string>();
    for (const row of [...firstBody.records, ...secondBody.records]) seen.add(row.id);
    expect(seen.size).toBe(6);
  });
});

describe("GET /v1/stock/ledger — void and refund visibility", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await buildFixture();
  });
  afterAll(async () => {
    await fixture.app.close();
  });

  it("includes balancing rows after POST /void with reason=sale_void and positive deltas", async () => {
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
      url: `/v1/stock/ledger?outletId=${OUTLET_A}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LedgerEnvelope;
    // 2 sales × 3 components + 1 void × 3 balancing rows = 9.
    expect(body.records).toHaveLength(9);
    const voidRows = body.records.filter((row) => row.reason === "sale_void");
    expect(voidRows).toHaveLength(3);
    for (const row of voidRows) {
      expect(row.refType).toBe("sale");
      expect(row.refId).toBe(fixture.saleA1);
      expect(row.delta).toBeGreaterThan(0);
    }
  });

  it("includes balancing rows after POST /refund with reason=refund and positive deltas", async () => {
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
      url: `/v1/stock/ledger?outletId=${OUTLET_A}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LedgerEnvelope;
    // 2 sales × 3 components + 1 refund × 3 balancing rows = 9.
    expect(body.records).toHaveLength(9);
    const refundRows = body.records.filter((row) => row.reason === "refund");
    expect(refundRows).toHaveLength(3);
    for (const row of refundRows) {
      expect(row.refType).toBe("sale");
      expect(row.refId).toBe(fixture.saleA1);
      expect(row.delta).toBeGreaterThan(0);
    }
  });
});
