import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  CashierDayService,
  InMemoryCashierDayRepository,
  type SeededSale,
  type SeededShift,
  type SeededStaff,
} from "../src/services/cashier-day/index.js";
import {
  InMemoryOutletsRepository,
  OutletsService,
  type SeedOutletInput,
} from "../src/services/outlets/index.js";
import { DashboardService, InMemoryDashboardRepository } from "../src/services/dashboard/index.js";

/*
 * Wire-level coverage for `GET /v1/reports/cashier-day` and the matching
 * CSV export (KASA-368).
 *
 * The aggregator is exercised end-to-end via the route so the response
 * shape, role gating, totals derivation, and CSV envelope (BOM, separator,
 * filename) are pinned in one place.
 */

const STAFF_TOKEN = "test-staff-token-1234567890abcdef";
const MERCHANT = "01890abc-1234-7def-8000-00000000aaa1";
const OTHER_MERCHANT = "01890abc-1234-7def-8000-00000000bbb1";
const OUTLET_A = "01890abc-1234-7def-8000-000000000001";
const OUTLET_B = "01890abc-1234-7def-8000-000000000002";
const STAFF_USER = "01890abc-1234-7def-8000-000000000020";
const CASHIER_SITI = "01890abc-1234-7def-8000-000000000031";
const CASHIER_DEWI = "01890abc-1234-7def-8000-000000000032";
const CASHIER_BUDI = "01890abc-1234-7def-8000-000000000033";

const TODAY = "2026-05-29";
const YESTERDAY = "2026-05-28";

interface Harness {
  app: FastifyInstance;
  repo: InMemoryCashierDayRepository;
  outlets: InMemoryOutletsRepository;
}

async function setup(overrides: { withOutlets?: boolean } = {}): Promise<Harness> {
  const repo = new InMemoryCashierDayRepository();
  const cashierDay = new CashierDayService({ repository: repo });
  const dashboardRepo = new InMemoryDashboardRepository();
  const dashboard = new DashboardService({ repository: dashboardRepo });
  const outlets = new InMemoryOutletsRepository();
  const outletsService = new OutletsService({ repository: outlets });
  const now = new Date("2026-05-29T00:00:00.000Z");
  outlets.seedOutlet(seedOutlet(OUTLET_A, "warung-pusat", "Warung Pusat", now));
  outlets.seedOutlet(seedOutlet(OUTLET_B, "cabang-bandung", "Cabang Bandung", now));
  const app = await buildApp({
    reports: { service: dashboard, cashierDay, staffBootstrapToken: STAFF_TOKEN },
    outlets: { service: outletsService },
  });
  await app.ready();
  return { app, repo, outlets };
}

function seedOutlet(outletId: string, code: string, name: string, now: Date): SeedOutletInput {
  return {
    id: outletId,
    merchantId: MERCHANT,
    code,
    name,
    createdAt: now,
    updatedAt: now,
  };
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
  repo: InMemoryCashierDayRepository,
  sale: Partial<SeededSale> & { saleId: string },
) {
  const full: SeededSale = {
    saleId: sale.saleId,
    merchantId: sale.merchantId ?? MERCHANT,
    outletId: sale.outletId ?? OUTLET_A,
    cashierStaffId: sale.cashierStaffId ?? CASHIER_SITI,
    businessDate: sale.businessDate ?? TODAY,
    totalIdr: sale.totalIdr ?? 0,
    status: sale.status ?? "finalised",
    synthetic: sale.synthetic ?? false,
    voidBusinessDate: sale.voidBusinessDate ?? null,
    tenders: sale.tenders ?? [],
  };
  repo.seedSale(full);
}

function seedStaff(repo: InMemoryCashierDayRepository, staff: SeededStaff) {
  repo.seedStaff(staff);
}

function seedShift(repo: InMemoryCashierDayRepository, shift: SeededShift) {
  repo.seedShift(shift);
}

describe("GET /v1/reports/cashier-day", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
    seedStaff(h.repo, { staffId: CASHIER_SITI, merchantId: MERCHANT, displayName: "Siti Rahayu" });
    seedStaff(h.repo, { staffId: CASHIER_DEWI, merchantId: MERCHANT, displayName: "Dewi Lestari" });
    seedStaff(h.repo, { staffId: CASHIER_BUDI, merchantId: MERCHANT, displayName: "Budi Santoso" });
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("aggregates per-cashier rows with tender mix, voids, and totals", async () => {
    // 3 cashiers × 5 finalised sales × mixed tenders + 1 void on Siti.
    const makeSale = (
      saleId: string,
      cashier: string,
      totalIdr: number,
      method: "cash" | "qris_dynamic" | "qris_static",
    ) =>
      seedSale(h.repo, {
        saleId,
        cashierStaffId: cashier,
        totalIdr,
        tenders: [{ method, amountIdr: totalIdr }],
      });
    // Siti: 4 finalised + 1 void (the 5th sale, voided same day).
    makeSale("01890abc-1234-7def-8000-0000000001a1", CASHIER_SITI, 25_000, "cash");
    makeSale("01890abc-1234-7def-8000-0000000001a2", CASHIER_SITI, 36_000, "qris_dynamic");
    makeSale("01890abc-1234-7def-8000-0000000001a3", CASHIER_SITI, 18_000, "cash");
    makeSale("01890abc-1234-7def-8000-0000000001a4", CASHIER_SITI, 12_000, "qris_static");
    seedSale(h.repo, {
      saleId: "01890abc-1234-7def-8000-0000000001a5",
      cashierStaffId: CASHIER_SITI,
      totalIdr: 9_000,
      voidBusinessDate: TODAY,
      status: "voided",
      tenders: [{ method: "cash", amountIdr: 9_000 }],
    });
    // Dewi: 5 finalised
    makeSale("01890abc-1234-7def-8000-0000000002b1", CASHIER_DEWI, 50_000, "cash");
    makeSale("01890abc-1234-7def-8000-0000000002b2", CASHIER_DEWI, 21_000, "cash");
    makeSale("01890abc-1234-7def-8000-0000000002b3", CASHIER_DEWI, 14_500, "qris_dynamic");
    makeSale("01890abc-1234-7def-8000-0000000002b4", CASHIER_DEWI, 11_000, "qris_static");
    makeSale("01890abc-1234-7def-8000-0000000002b5", CASHIER_DEWI, 8_000, "cash");
    // Budi: 5 finalised
    makeSale("01890abc-1234-7def-8000-0000000003c1", CASHIER_BUDI, 30_000, "qris_dynamic");
    makeSale("01890abc-1234-7def-8000-0000000003c2", CASHIER_BUDI, 12_000, "cash");
    makeSale("01890abc-1234-7def-8000-0000000003c3", CASHIER_BUDI, 15_000, "qris_static");
    makeSale("01890abc-1234-7def-8000-0000000003c4", CASHIER_BUDI, 9_500, "qris_dynamic");
    makeSale("01890abc-1234-7def-8000-0000000003c5", CASHIER_BUDI, 4_000, "cash");

    // Wrong merchant / wrong outlet / wrong date — should be ignored.
    seedSale(h.repo, {
      saleId: "01890abc-1234-7def-8000-0000000000f1",
      merchantId: OTHER_MERCHANT,
      totalIdr: 999_999,
      tenders: [{ method: "cash", amountIdr: 999_999 }],
    });
    seedSale(h.repo, {
      saleId: "01890abc-1234-7def-8000-0000000000f2",
      outletId: OUTLET_B,
      totalIdr: 999_999,
      tenders: [{ method: "cash", amountIdr: 999_999 }],
    });
    seedSale(h.repo, {
      saleId: "01890abc-1234-7def-8000-0000000000f3",
      businessDate: YESTERDAY,
      totalIdr: 999_999,
      tenders: [{ method: "cash", amountIdr: 999_999 }],
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/cashier-day?outletId=${OUTLET_A}&businessDate=${TODAY}`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      outletId: string;
      businessDate: string;
      rows: Array<{
        cashierStaffId: string;
        cashierName: string;
        saleCount: number;
        grossIdr: number;
        netIdr: number;
        voidCount: number;
        voidIdr: number;
        tenderMix: Array<{ method: string; amountIdr: number; count: number }>;
        drawerExpectedIdr: number | null;
      }>;
      totals: {
        saleCount: number;
        grossIdr: number;
        netIdr: number;
        voidCount: number;
        voidIdr: number;
        tenderMix: Array<{ method: string; amountIdr: number; count: number }>;
        drawerExpectedIdr: number | null;
      };
    };

    expect(body.outletId).toBe(OUTLET_A);
    expect(body.businessDate).toBe(TODAY);
    expect(body.rows).toHaveLength(3);

    const siti = body.rows.find((r) => r.cashierStaffId === CASHIER_SITI);
    expect(siti).toBeDefined();
    expect(siti?.cashierName).toBe("Siti Rahayu");
    expect(siti?.saleCount).toBe(4);
    expect(siti?.grossIdr).toBe(91_000);
    expect(siti?.voidCount).toBe(1);
    expect(siti?.voidIdr).toBe(9_000);
    expect(siti?.netIdr).toBe(82_000);
    expect(siti?.drawerExpectedIdr).toBeNull();

    const dewi = body.rows.find((r) => r.cashierStaffId === CASHIER_DEWI);
    expect(dewi?.saleCount).toBe(5);
    expect(dewi?.grossIdr).toBe(104_500);
    expect(dewi?.netIdr).toBe(104_500);

    const budi = body.rows.find((r) => r.cashierStaffId === CASHIER_BUDI);
    expect(budi?.saleCount).toBe(5);
    expect(budi?.grossIdr).toBe(70_500);

    expect(body.totals.saleCount).toBe(14);
    expect(body.totals.grossIdr).toBe(266_000);
    expect(body.totals.voidCount).toBe(1);
    expect(body.totals.voidIdr).toBe(9_000);
    expect(body.totals.netIdr).toBe(257_000);

    const cashSlice = body.totals.tenderMix.find((s) => s.method === "cash");
    expect(cashSlice?.amountIdr).toBe(25_000 + 18_000 + 50_000 + 21_000 + 8_000 + 12_000 + 4_000);
    const qrisDyn = body.totals.tenderMix.find((s) => s.method === "qris_dynamic");
    expect(qrisDyn?.amountIdr).toBe(36_000 + 14_500 + 30_000 + 9_500);
    const qrisStatic = body.totals.tenderMix.find((s) => s.method === "qris_static");
    expect(qrisStatic?.amountIdr).toBe(12_000 + 11_000 + 15_000);

    expect(body.rows.map((r) => r.cashierStaffId)).toEqual([
      CASHIER_DEWI,
      CASHIER_SITI,
      CASHIER_BUDI,
    ]);
  });

  it("returns the canonical empty shape when no cashier sold on the date", async () => {
    seedSale(h.repo, {
      saleId: "01890abc-1234-7def-8000-0000000007e1",
      businessDate: YESTERDAY,
      totalIdr: 50_000,
      tenders: [{ method: "cash", amountIdr: 50_000 }],
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/cashier-day?outletId=${OUTLET_A}&businessDate=${TODAY}`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rows: unknown[];
      totals: { saleCount: number; grossIdr: number; drawerExpectedIdr: number | null };
    };
    expect(body.rows).toEqual([]);
    expect(body.totals.saleCount).toBe(0);
    expect(body.totals.grossIdr).toBe(0);
    expect(body.totals.drawerExpectedIdr).toBeNull();
  });

  it("derives drawerExpected = openingFloat + cashNet when a shift exists", async () => {
    seedSale(h.repo, {
      saleId: "01890abc-1234-7def-8000-000000000801",
      cashierStaffId: CASHIER_SITI,
      totalIdr: 25_000,
      tenders: [{ method: "cash", amountIdr: 25_000 }],
    });
    seedShift(h.repo, {
      merchantId: MERCHANT,
      outletId: OUTLET_A,
      cashierStaffId: CASHIER_SITI,
      businessDate: TODAY,
      openingFloatIdr: 100_000,
      cashNetIdr: 25_000,
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/cashier-day?outletId=${OUTLET_A}&businessDate=${TODAY}`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rows: Array<{ drawerExpectedIdr: number | null }>;
      totals: { drawerExpectedIdr: number | null };
    };
    expect(body.rows[0]?.drawerExpectedIdr).toBe(125_000);
    expect(body.totals.drawerExpectedIdr).toBe(125_000);
  });

  it("manager role is allowed", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/cashier-day?outletId=${OUTLET_A}&businessDate=${TODAY}`,
      headers: staffHeaders({ "x-staff-role": "manager" }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("403 when staff role is cashier", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/cashier-day?outletId=${OUTLET_A}&businessDate=${TODAY}`,
      headers: staffHeaders({ "x-staff-role": "cashier" }),
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("422 when businessDate is malformed", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/cashier-day?outletId=${OUTLET_A}&businessDate=yesterday`,
      headers: staffHeaders(),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("401 when no staff session", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/cashier-day?outletId=${OUTLET_A}&businessDate=${TODAY}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("503 when STAFF_BOOTSTRAP_TOKEN is unset", async () => {
    const repo = new InMemoryCashierDayRepository();
    const cashierDay = new CashierDayService({ repository: repo });
    const dashboardRepo = new InMemoryDashboardRepository();
    const dashboard = new DashboardService({ repository: dashboardRepo });
    const app = await buildApp({ reports: { service: dashboard, cashierDay } });
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/reports/cashier-day?outletId=${OUTLET_A}&businessDate=${TODAY}`,
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "staff_bootstrap_disabled",
      );
    } finally {
      await app.close();
    }
  });

  it("returns an empty bucket when outletId belongs to another merchant (no cross-tenant leak)", async () => {
    // Wrong-merchant outlet id: the staff principal is MERCHANT but the
    // query targets an outlet owned by OTHER_MERCHANT. Since the service
    // scopes on (merchant, outlet), the repository finds no rows and we
    // return the canonical empty shape — never a 404 (would leak existence).
    seedSale(h.repo, {
      saleId: "01890abc-1234-7def-8000-0000000009e1",
      merchantId: OTHER_MERCHANT,
      outletId: OUTLET_A,
      totalIdr: 50_000,
      tenders: [{ method: "cash", amountIdr: 50_000 }],
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/cashier-day?outletId=${OUTLET_A}&businessDate=${TODAY}`,
      headers: staffHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });
});

describe("GET /v1/reports/cashier-day/export.csv", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
    seedStaff(h.repo, { staffId: CASHIER_SITI, merchantId: MERCHANT, displayName: "Siti Rahayu" });
    seedStaff(h.repo, { staffId: CASHIER_DEWI, merchantId: MERCHANT, displayName: "Dewi Lestari" });
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("emits BOM-prefixed `;`-separated CSV with totals row + pinned filename", async () => {
    seedSale(h.repo, {
      saleId: "01890abc-1234-7def-8000-0000000004f1",
      cashierStaffId: CASHIER_SITI,
      totalIdr: 25_000,
      tenders: [{ method: "cash", amountIdr: 25_000 }],
    });
    seedSale(h.repo, {
      saleId: "01890abc-1234-7def-8000-0000000004f2",
      cashierStaffId: CASHIER_DEWI,
      totalIdr: 36_000,
      tenders: [{ method: "qris_dynamic", amountIdr: 36_000 }],
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/cashier-day/export.csv?outletId=${OUTLET_A}&businessDate=${TODAY}`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    const disposition = String(res.headers["content-disposition"] ?? "");
    expect(disposition).toContain(`filename="kassa-cashier-day-warung-pusat-${TODAY}.csv"`);

    const body = res.body;
    expect(body.startsWith("﻿")).toBe(true);
    const lines = body.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe(
      "cashier;sale_count;gross;net;void_count;void_total;cash;qris_dynamic;qris_static;drawer_expected",
    );
    // 2 data rows + totals
    expect(lines.length).toBe(5);
    expect(lines[lines.length - 1]).toBe("");
    const totalsRow = lines[lines.length - 2]!;
    const totalsCells = totalsRow.split(";");
    expect(totalsCells[0]).toBe("Total");
    expect(totalsCells[1]).toBe("2"); // sale_count
    expect(totalsCells[2]).toBe("61000"); // gross
    expect(totalsCells[3]).toBe("61000"); // net
    expect(totalsCells[4]).toBe("0"); // void_count
    expect(totalsCells[5]).toBe("0"); // void_total
    expect(totalsCells[6]).toBe("25000"); // cash
    expect(totalsCells[7]).toBe("36000"); // qris_dynamic
    expect(totalsCells[8]).toBe("0"); // qris_static
    expect(totalsCells[9]).toBe(""); // drawer_expected null
  });

  it("404 when the outlet does not belong to the caller's merchant", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/cashier-day/export.csv?outletId=01890abc-1234-7def-8000-0000000099ee&businessDate=${TODAY}`,
      headers: staffHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("outlet_not_found");
  });

  it("403 when the caller is a cashier", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/cashier-day/export.csv?outletId=${OUTLET_A}&businessDate=${TODAY}`,
      headers: staffHeaders({ "x-staff-role": "cashier" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("emits a CSV with only a totals row when no sales exist for the day", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/cashier-day/export.csv?outletId=${OUTLET_A}&businessDate=${TODAY}`,
      headers: staffHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.replace(/^﻿/, "").split("\r\n");
    expect(lines).toEqual([
      "cashier;sale_count;gross;net;void_count;void_total;cash;qris_dynamic;qris_static;drawer_expected",
      "Total;0;0;0;0;0;0;0;0;",
      "",
    ]);
  });
});
