import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  InMemorySalesSummaryRepository,
  SalesSummaryService,
  type SeededSale,
} from "../src/services/sales-summary/index.js";

/*
 * Wire-level coverage for `GET /v1/admin/sales/summary` (KASA-327).
 *
 * Exercises the period-summary aggregator end-to-end so the response
 * shape, role gating, 92-day cap, and Zod validation are pinned in
 * one place. The PPN line and a void-netting case are explicit ACs
 * from the issue description.
 */

const STAFF_TOKEN = "test-staff-token-1234567890abcdef";
const MERCHANT = "01890abc-1234-7def-8000-00000000aaa1";
const OTHER_MERCHANT = "01890abc-1234-7def-8000-00000000bbb1";
const OUTLET_A = "01890abc-1234-7def-8000-000000000001";
const OUTLET_B = "01890abc-1234-7def-8000-000000000002";
const STAFF_USER = "01890abc-1234-7def-8000-000000000020";
const ITEM_COFFEE = "01890abc-1234-7def-8000-0000000c0001";
const ITEM_BREAD = "01890abc-1234-7def-8000-0000000c0002";
const SALE_BASE = "01890abc-1234-7def-8000-000000000500";

const TODAY = "2026-04-25";
const YESTERDAY = "2026-04-24";

interface Harness {
  app: FastifyInstance;
  repo: InMemorySalesSummaryRepository;
}

async function setup(): Promise<Harness> {
  const repo = new InMemorySalesSummaryRepository();
  const service = new SalesSummaryService({ repository: repo });
  const app = await buildApp({ adminSales: { service, staffBootstrapToken: STAFF_TOKEN } });
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
  repo: InMemorySalesSummaryRepository,
  sale: Partial<SeededSale> & { saleId: string },
) {
  const fullSale: SeededSale = {
    saleId: sale.saleId,
    merchantId: sale.merchantId ?? MERCHANT,
    outletId: sale.outletId ?? OUTLET_A,
    businessDate: sale.businessDate ?? TODAY,
    discountIdr: sale.discountIdr ?? 0,
    totalIdr: sale.totalIdr ?? 0,
    taxIdr: sale.taxIdr ?? 0,
    status: sale.status ?? "finalised",
    synthetic: sale.synthetic ?? false,
    voided: sale.voided ?? false,
    lines: sale.lines ?? [],
    tenders: sale.tenders ?? [],
    ...(sale.voidBusinessDate !== undefined ? { voidBusinessDate: sale.voidBusinessDate } : {}),
    ...(sale.subtotalIdr !== undefined ? { subtotalIdr: sale.subtotalIdr } : {}),
  };
  repo.seedSale(fullSale);
}

describe("GET /v1/admin/sales/summary", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
    h.repo.seedItem({ itemId: ITEM_COFFEE, merchantId: MERCHANT, name: "Kopi Susu" });
    h.repo.seedItem({ itemId: ITEM_BREAD, merchantId: MERCHANT, name: "Roti Bakar" });
    h.repo.seedOutlet({ outletId: OUTLET_A, merchantId: MERCHANT, name: "Warung Pusat" });
    h.repo.seedOutlet({ outletId: OUTLET_B, merchantId: MERCHANT, name: "Cabang Bandung" });
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("returns gross / PPN / tender mix and a per-day breakdown when groupBy=day", async () => {
    seedSale(h.repo, {
      saleId: `${SALE_BASE}1`,
      businessDate: YESTERDAY,
      totalIdr: 27_750,
      taxIdr: 2_750,
      discountIdr: 1_000,
      lines: [
        { itemId: ITEM_COFFEE, quantity: 1, lineTotalIdr: 18_000 },
        { itemId: ITEM_BREAD, quantity: 1, lineTotalIdr: 9_750 },
      ],
      tenders: [{ method: "cash", amountIdr: 27_750 }],
    });
    seedSale(h.repo, {
      saleId: `${SALE_BASE}2`,
      businessDate: TODAY,
      totalIdr: 36_000,
      taxIdr: 3_565,
      lines: [{ itemId: ITEM_COFFEE, quantity: 2, lineTotalIdr: 36_000 }],
      tenders: [{ method: "qris_dynamic", amountIdr: 36_000 }],
    });
    // Voided, synthetic, and wrong-merchant rows must not feed the
    // headline gross/tax/saleCount.
    seedSale(h.repo, { saleId: `${SALE_BASE}3`, totalIdr: 999, voided: true });
    seedSale(h.repo, { saleId: `${SALE_BASE}4`, totalIdr: 999, synthetic: true });
    seedSale(h.repo, {
      saleId: `${SALE_BASE}5`,
      merchantId: OTHER_MERCHANT,
      totalIdr: 999,
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=${YESTERDAY}&to=${TODAY}&groupBy=day`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      outletId: string | null;
      groupBy: string;
      grossIdr: number;
      discountIdr: number;
      taxIdr: number;
      netIdr: number;
      saleCount: number;
      refundCount: number;
      refundIdr: number;
      tenderMix: { method: string; amountIdr: number; count: number }[];
      topItemsByRevenue: { itemId: string; revenueIdr: number; quantity: number }[];
      groups: {
        key: string;
        label: string;
        grossIdr: number;
        taxIdr: number;
        saleCount: number;
        refundCount: number;
        refundIdr: number;
      }[];
    };

    expect(body.outletId).toBeNull();
    expect(body.groupBy).toBe("day");
    expect(body.grossIdr).toBe(63_750);
    expect(body.discountIdr).toBe(1_000);
    expect(body.taxIdr).toBe(6_315);
    expect(body.netIdr).toBe(57_435);
    expect(body.saleCount).toBe(2);
    // Refunds row picks up the void sale on TODAY (defaulted from `businessDate`).
    expect(body.refundCount).toBe(1);
    expect(body.refundIdr).toBe(999);

    expect(body.tenderMix).toEqual([
      { method: "qris_dynamic", amountIdr: 36_000, count: 1 },
      { method: "cash", amountIdr: 27_750, count: 1 },
    ]);

    expect(body.topItemsByRevenue[0]).toMatchObject({
      itemId: ITEM_COFFEE,
      revenueIdr: 54_000,
      quantity: 3,
    });

    const dayKeys = body.groups.map((g) => g.key);
    expect(dayKeys).toEqual([YESTERDAY, TODAY]);
    const todayRow = body.groups.find((g) => g.key === TODAY);
    expect(todayRow).toMatchObject({
      grossIdr: 36_000,
      taxIdr: 3_565,
      saleCount: 1,
      refundCount: 1,
      refundIdr: 999,
    });
  });

  it("attributes voids to their voidBusinessDate, not the original sale day", async () => {
    seedSale(h.repo, {
      saleId: `${SALE_BASE}1`,
      businessDate: YESTERDAY,
      totalIdr: 50_000,
      voided: true,
      // 23:55 sale voided at 00:05 — owns the next day's books (KASA-236).
      voidBusinessDate: TODAY,
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=${YESTERDAY}&to=${TODAY}&groupBy=day`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      refundCount: number;
      refundIdr: number;
      groups: { key: string; refundCount: number; refundIdr: number }[];
    };
    expect(body.refundCount).toBe(1);
    expect(body.refundIdr).toBe(50_000);
    const todayRow = body.groups.find((g) => g.key === TODAY);
    const yesterdayRow = body.groups.find((g) => g.key === YESTERDAY);
    expect(todayRow?.refundIdr).toBe(50_000);
    expect(yesterdayRow).toBeUndefined();
  });

  it("groups by outlet with one row per outletId", async () => {
    seedSale(h.repo, {
      saleId: `${SALE_BASE}1`,
      outletId: OUTLET_A,
      totalIdr: 80_000,
      taxIdr: 7_928,
      tenders: [{ method: "cash", amountIdr: 80_000 }],
    });
    seedSale(h.repo, {
      saleId: `${SALE_BASE}2`,
      outletId: OUTLET_B,
      totalIdr: 25_000,
      taxIdr: 2_478,
      tenders: [{ method: "qris_static", amountIdr: 25_000 }],
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=${TODAY}&to=${TODAY}&groupBy=outlet`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      groupBy: string;
      groups: { key: string; label: string; grossIdr: number }[];
    };
    expect(body.groupBy).toBe("outlet");
    expect(body.groups).toHaveLength(2);
    expect(body.groups[0]).toMatchObject({ key: OUTLET_A, grossIdr: 80_000 });
    expect(body.groups[1]).toMatchObject({ key: OUTLET_B, grossIdr: 25_000 });
  });

  it("groups by tender with one row per tender method", async () => {
    seedSale(h.repo, {
      saleId: `${SALE_BASE}1`,
      totalIdr: 30_000,
      tenders: [{ method: "cash", amountIdr: 30_000 }],
    });
    seedSale(h.repo, {
      saleId: `${SALE_BASE}2`,
      totalIdr: 20_000,
      tenders: [{ method: "qris_dynamic", amountIdr: 20_000 }],
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=${TODAY}&to=${TODAY}&groupBy=tender`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      groups: { key: string; grossIdr: number; saleCount: number }[];
    };
    expect(body.groups).toHaveLength(2);
    const cash = body.groups.find((g) => g.key === "cash");
    const qris = body.groups.find((g) => g.key === "qris_dynamic");
    expect(cash).toMatchObject({ grossIdr: 30_000, saleCount: 1 });
    expect(qris).toMatchObject({ grossIdr: 20_000, saleCount: 1 });
  });

  it("groups by item with revenue + quantity per item", async () => {
    seedSale(h.repo, {
      saleId: `${SALE_BASE}1`,
      totalIdr: 27_750,
      lines: [
        { itemId: ITEM_COFFEE, quantity: 2, lineTotalIdr: 36_000 },
        { itemId: ITEM_BREAD, quantity: 1, lineTotalIdr: 9_750 },
      ],
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=${TODAY}&to=${TODAY}&groupBy=item`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      groups: { key: string; label: string; grossIdr: number; quantity: number }[];
    };
    expect(body.groups).toHaveLength(2);
    expect(body.groups[0]).toMatchObject({
      key: ITEM_COFFEE,
      label: "Kopi Susu",
      grossIdr: 36_000,
      quantity: 2,
    });
    expect(body.groups[1]).toMatchObject({
      key: ITEM_BREAD,
      label: "Roti Bakar",
      grossIdr: 9_750,
      quantity: 1,
    });
  });

  it("filters by outletId when provided", async () => {
    seedSale(h.repo, {
      saleId: `${SALE_BASE}1`,
      outletId: OUTLET_A,
      totalIdr: 50_000,
    });
    seedSale(h.repo, {
      saleId: `${SALE_BASE}2`,
      outletId: OUTLET_B,
      totalIdr: 12_000,
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=${TODAY}&to=${TODAY}&groupBy=day&outletId=${OUTLET_A}`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { outletId: string; grossIdr: number; saleCount: number };
    expect(body.outletId).toBe(OUTLET_A);
    expect(body.grossIdr).toBe(50_000);
    expect(body.saleCount).toBe(1);
  });

  it("returns 400 range_too_large when the window exceeds 92 days", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=2026-01-01&to=2026-12-31&groupBy=day`,
      headers: staffHeaders(),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("range_too_large");
    expect(body.error.message).toMatch(/92/);
  });

  it("accepts the boundary 92-day window", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=2026-01-01&to=2026-04-02&groupBy=day`,
      headers: staffHeaders(),
    });
    expect(res.statusCode).toBe(200);
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
      url: `/v1/admin/sales/summary?from=${TODAY}&to=${TODAY}&groupBy=day`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      grossIdr: number;
      saleCount: number;
      refundCount: number;
      tenderMix: unknown[];
      topItemsByRevenue: unknown[];
      groups: unknown[];
    };
    expect(body.grossIdr).toBe(0);
    expect(body.saleCount).toBe(0);
    expect(body.refundCount).toBe(0);
    expect(body.tenderMix).toEqual([]);
    expect(body.topItemsByRevenue).toEqual([]);
    expect(body.groups).toEqual([]);
  });

  it("manager role is allowed (owner+manager tier)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=${TODAY}&to=${TODAY}&groupBy=day`,
      headers: staffHeaders({ "x-staff-role": "manager" }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("403 when the staff role is cashier", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=${TODAY}&to=${TODAY}&groupBy=day`,
      headers: staffHeaders({ "x-staff-role": "cashier" }),
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("422 when from > to", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=${TODAY}&to=${YESTERDAY}&groupBy=day`,
      headers: staffHeaders(),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("422 when groupBy is missing or unknown", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=${TODAY}&to=${TODAY}&groupBy=year`,
      headers: staffHeaders(),
    });
    expect(res.statusCode).toBe(422);
  });

  it("401 when no staff session", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/admin/sales/summary?from=${TODAY}&to=${TODAY}&groupBy=day`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("503 when STAFF_BOOTSTRAP_TOKEN is unset", async () => {
    const repo = new InMemorySalesSummaryRepository();
    const service = new SalesSummaryService({ repository: repo });
    const app = await buildApp({ adminSales: { service } });
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/admin/sales/summary?from=${TODAY}&to=${TODAY}&groupBy=day`,
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
