import { describe, expect, it } from "vitest";
import { toRupiah } from "../../shared/money/index.ts";
import type { PendingSale } from "../../data/db/types.ts";
import { computeEodTotals } from "./totals.ts";

const OUTLET = "outlet-1";
const OTHER_OUTLET = "outlet-2";
const BUSINESS_DATE = "2026-04-23";

function sale(overrides: Partial<PendingSale> & { id: string }): PendingSale {
  return {
    localSaleId: overrides.id,
    outletId: overrides.outletId ?? OUTLET,
    clerkId: "clerk-1",
    businessDate: overrides.businessDate ?? BUSINESS_DATE,
    createdAt: overrides.createdAt ?? "2026-04-23T03:00:00.000Z",
    subtotalIdr: overrides.subtotalIdr ?? toRupiah(50_000),
    discountIdr: overrides.discountIdr ?? toRupiah(0),
    totalIdr: overrides.totalIdr ?? toRupiah(50_000),
    items: overrides.items ?? [],
    tenders: overrides.tenders ?? [
      { method: "cash", amountIdr: toRupiah(50_000), reference: null },
    ],
    status: overrides.status ?? "queued",
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    serverSaleName: null,
  };
}

describe("computeEodTotals", () => {
  it("sums cash and qris, and filters by (outletId, businessDate)", () => {
    const totals = computeEodTotals({
      sales: [
        sale({ id: "s1", totalIdr: toRupiah(30_000) }),
        sale({
          id: "s2",
          totalIdr: toRupiah(50_000),
          tenders: [{ method: "qris", amountIdr: toRupiah(50_000), reference: "ref" }],
        }),
        sale({ id: "s3", outletId: OTHER_OUTLET, totalIdr: toRupiah(99_000) }),
        sale({ id: "s4", businessDate: "2026-04-22", totalIdr: toRupiah(11_000) }),
      ],
      outletId: OUTLET,
      businessDate: BUSINESS_DATE,
    });
    expect(totals.cashIdr).toBe(30_000);
    expect(totals.qrisUnverifiedIdr).toBe(50_000);
    expect(totals.netIdr).toBe(80_000);
    expect(totals.saleCount).toBe(2);
    expect(totals.clientSaleIds).toEqual(["s1", "s2"]);
  });

  it("splits a mixed-tender sale: cash = total − non-cash, clamped to [0, total]", () => {
    const totals = computeEodTotals({
      sales: [
        sale({
          id: "mixed",
          totalIdr: toRupiah(30_000),
          tenders: [
            { method: "qris", amountIdr: toRupiah(20_000), reference: "r" },
            { method: "cash", amountIdr: toRupiah(10_000), reference: null },
          ],
        }),
      ],
      outletId: OUTLET,
      businessDate: BUSINESS_DATE,
    });
    expect(totals.cashIdr).toBe(10_000);
    expect(totals.qrisUnverifiedIdr).toBe(20_000);
  });

  it("handles an over-tendered cash sale without counting the change as revenue", () => {
    // tendered 100k on a 50k total — drawer only gets 50k.
    const totals = computeEodTotals({
      sales: [
        sale({
          id: "overtendered",
          totalIdr: toRupiah(50_000),
          tenders: [{ method: "cash", amountIdr: toRupiah(100_000), reference: null }],
        }),
      ],
      outletId: OUTLET,
      businessDate: BUSINESS_DATE,
    });
    expect(totals.cashIdr).toBe(50_000);
    expect(totals.netIdr).toBe(50_000);
  });

  it("returns zero totals and empty ids for a day with no sales", () => {
    const totals = computeEodTotals({ sales: [], outletId: OUTLET, businessDate: BUSINESS_DATE });
    expect(totals.cashIdr).toBe(0);
    expect(totals.qrisUnverifiedIdr).toBe(0);
    expect(totals.netIdr).toBe(0);
    expect(totals.saleCount).toBe(0);
    expect(totals.clientSaleIds).toEqual([]);
  });
});
