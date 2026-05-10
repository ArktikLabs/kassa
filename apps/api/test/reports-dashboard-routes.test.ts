import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  DashboardService,
  InMemoryDashboardRepository,
  type SeededSale,
} from "../src/services/dashboard/index.js";

/*
 * Wire-level coverage for `GET /v1/reports/dashboard` (KASA-237).
 *
 * The aggregator unit (`dashboard-summary.test.ts` — covered separately by
 * the in-memory repo's own filter behaviour exercised here) is exercised
 * end-to-end via the route so the response shape, role gating, and Zod
 * validation are pinned in one place.
 */

const STAFF_TOKEN = "test-staff-token-1234567890abcdef";
const MERCHANT = "01890abc-1234-7def-8000-00000000aaa1";
const OTHER_MERCHANT = "01890abc-1234-7def-8000-00000000bbb1";
const OUTLET_A = "01890abc-1234-7def-8000-000000000001";
const OUTLET_B = "01890abc-1234-7def-8000-000000000002";
const STAFF_USER = "01890abc-1234-7def-8000-000000000020";
const ITEM_COFFEE = "01890abc-1234-7def-8000-0000000c0001";
const ITEM_BREAD = "01890abc-1234-7def-8000-0000000c0002";
const ITEM_TEA = "01890abc-1234-7def-8000-0000000c0003";
const SALE_BASE = "01890abc-1234-7def-8000-000000000400";

const TODAY = "2026-04-25";
const YESTERDAY = "2026-04-24";

interface Harness {
  app: FastifyInstance;
  repo: InMemoryDashboardRepository;
}

async function setup(): Promise<Harness> {
  const repo = new InMemoryDashboardRepository();
  const service = new DashboardService({ repository: repo });
  const app = await buildApp({ reports: { service, staffBootstrapToken: STAFF_TOKEN } });
  await app.ready();
  return { app, repo };
}

function staffHeaders(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${STAFF_TOKEN}`,
    "x-staff-user-id": STAFF_USER,
    "x-staff-merchant-id": MERCHANT,
    "x-staff-role": "owner",
    ...overrides,
  };
}

function seedSale(
  repo: InMemoryDashboardRepository,
  sale: Partial<SeededSale> & { saleId: string },
) {
  const fullSale: SeededSale = {
    saleId: sale.saleId,
    merchantId: sale.merchantId ?? MERCHANT,
    outletId: sale.outletId ?? OUTLET_A,
    businessDate: sale.businessDate ?? TODAY,
    totalIdr: sale.totalIdr ?? 0,
    taxIdr: sale.taxIdr ?? 0,
    status: sale.status ?? "finalised",
    synthetic: sale.synthetic ?? false,
    voided: sale.voided ?? false,
    lines: sale.lines ?? [],
    tenders: sale.tenders ?? [],
  };
  repo.seedSale(fullSale);
}

describe("GET /v1/reports/dashboard", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
    h.repo.seedItem({ itemId: ITEM_COFFEE, merchantId: MERCHANT, name: "Kopi Susu" });
    h.repo.seedItem({ itemId: ITEM_BREAD, merchantId: MERCHANT, name: "Roti Bakar" });
    h.repo.seedItem({ itemId: ITEM_TEA, merchantId: MERCHANT, name: "Teh Tarik" });
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("aggregates revenue, tender mix, and top items across the window", async () => {
    seedSale(h.repo, {
      saleId: `${SALE_BASE}1`,
      totalIdr: 27_750,
      taxIdr: 2_750,
      lines: [
        { itemId: ITEM_COFFEE, quantity: 1, lineTotalIdr: 18_000 },
        { itemId: ITEM_BREAD, quantity: 1, lineTotalIdr: 9_750 },
      ],
      tenders: [{ method: "cash", amountIdr: 27_750 }],
    });
    seedSale(h.repo, {
      saleId: `${SALE_BASE}2`,
      totalIdr: 36_000,
      taxIdr: 3_565,
      lines: [{ itemId: ITEM_COFFEE, quantity: 2, lineTotalIdr: 36_000 }],
      tenders: [{ method: "qris_dynamic", amountIdr: 36_000 }],
    });
    // Voided / synthetic / wrong merchant — ignored.
    seedSale(h.repo, { saleId: `${SALE_BASE}3`, totalIdr: 999, voided: true });
    seedSale(h.repo, { saleId: `${SALE_BASE}4`, totalIdr: 999, synthetic: true });
    seedSale(h.repo, {
      saleId: `${SALE_BASE}5`,
      merchantId: OTHER_MERCHANT,
      totalIdr: 999,
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/dashboard?from=${TODAY}&to=${TODAY}`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      outletId: string | null;
      from: string;
      to: string;
      grossIdr: number;
      netIdr: number;
      taxIdr: number;
      saleCount: number;
      averageTicketIdr: number;
      tenderMix: { method: string; amountIdr: number }[];
      topItemsByRevenue: { itemId: string; name: string; revenueIdr: number; quantity: number }[];
      topItemsByQuantity: { itemId: string; quantity: number }[];
    };

    expect(body.outletId).toBeNull();
    expect(body.from).toBe(TODAY);
    expect(body.to).toBe(TODAY);
    expect(body.grossIdr).toBe(63_750);
    expect(body.taxIdr).toBe(6_315);
    expect(body.netIdr).toBe(57_435);
    expect(body.saleCount).toBe(2);
    expect(body.averageTicketIdr).toBe(31_875);

    expect(body.tenderMix).toEqual([
      { method: "qris_dynamic", amountIdr: 36_000, count: 1 },
      { method: "cash", amountIdr: 27_750, count: 1 },
    ]);

    expect(body.topItemsByRevenue[0]).toMatchObject({
      itemId: ITEM_COFFEE,
      name: "Kopi Susu",
      revenueIdr: 54_000,
      quantity: 3,
    });
    expect(body.topItemsByRevenue[1]).toMatchObject({
      itemId: ITEM_BREAD,
      revenueIdr: 9_750,
      quantity: 1,
    });

    expect(body.topItemsByQuantity[0]?.itemId).toBe(ITEM_COFFEE);
  });

  it("filters by outletId when provided", async () => {
    seedSale(h.repo, {
      saleId: `${SALE_BASE}1`,
      outletId: OUTLET_A,
      totalIdr: 50_000,
      tenders: [{ method: "cash", amountIdr: 50_000 }],
    });
    seedSale(h.repo, {
      saleId: `${SALE_BASE}2`,
      outletId: OUTLET_B,
      totalIdr: 12_000,
      tenders: [{ method: "qris_static", amountIdr: 12_000 }],
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/dashboard?from=${TODAY}&to=${TODAY}&outletId=${OUTLET_A}`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { outletId: string; grossIdr: number; saleCount: number };
    expect(body.outletId).toBe(OUTLET_A);
    expect(body.grossIdr).toBe(50_000);
    expect(body.saleCount).toBe(1);
  });

  it("returns the canonical zero shape when no sales fall in the window", async () => {
    seedSale(h.repo, {
      saleId: `${SALE_BASE}1`,
      businessDate: YESTERDAY,
      totalIdr: 50_000,
      tenders: [{ method: "cash", amountIdr: 50_000 }],
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/dashboard?from=${TODAY}&to=${TODAY}`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      grossIdr: number;
      saleCount: number;
      averageTicketIdr: number;
      tenderMix: unknown[];
      topItemsByRevenue: unknown[];
      topItemsByQuantity: unknown[];
    };
    expect(body.grossIdr).toBe(0);
    expect(body.saleCount).toBe(0);
    expect(body.averageTicketIdr).toBe(0);
    expect(body.tenderMix).toEqual([]);
    expect(body.topItemsByRevenue).toEqual([]);
    expect(body.topItemsByQuantity).toEqual([]);
  });

  it("manager role is allowed (owner+manager tier)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/dashboard?from=${TODAY}&to=${TODAY}`,
      headers: staffHeaders({ "x-staff-role": "manager" }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("403 when the staff role is cashier", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/dashboard?from=${TODAY}&to=${TODAY}`,
      headers: staffHeaders({ "x-staff-role": "cashier" }),
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("422 when from/to are malformed", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/reports/dashboard?from=yesterday&to=today",
      headers: staffHeaders(),
    });
    expect(res.statusCode).toBe(422);
  });

  it("422 when from > to", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/dashboard?from=${TODAY}&to=${YESTERDAY}`,
      headers: staffHeaders(),
    });
    expect(res.statusCode).toBe(422);
  });

  it("401 when no staff session", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/dashboard?from=${TODAY}&to=${TODAY}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("503 when STAFF_BOOTSTRAP_TOKEN is unset", async () => {
    const repo = new InMemoryDashboardRepository();
    const service = new DashboardService({ repository: repo });
    const app = await buildApp({ reports: { service } });
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/reports/dashboard?from=${TODAY}&to=${TODAY}`,
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "staff_bootstrap_disabled",
      );
    } finally {
      await app.close();
    }
  });
});
