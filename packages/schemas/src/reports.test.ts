import { describe, expect, it } from "vitest";
import { cashierDayQuery, cashierDayResponse } from "./reports.js";

describe("cashierDayQuery", () => {
  it("accepts a valid (outletId, businessDate) pair", () => {
    const out = cashierDayQuery.safeParse({
      outletId: "01890abc-1234-7def-8000-000000000001",
      businessDate: "2026-05-29",
    });
    expect(out.success).toBe(true);
  });

  it("rejects a non-uuid outletId", () => {
    const out = cashierDayQuery.safeParse({
      outletId: "not-a-uuid",
      businessDate: "2026-05-29",
    });
    expect(out.success).toBe(false);
  });

  it("rejects a businessDate that isn't YYYY-MM-DD", () => {
    const out = cashierDayQuery.safeParse({
      outletId: "01890abc-1234-7def-8000-000000000001",
      businessDate: "29-05-2026",
    });
    expect(out.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const out = cashierDayQuery.safeParse({
      outletId: "01890abc-1234-7def-8000-000000000001",
      businessDate: "2026-05-29",
      cashierId: "ignored",
    });
    expect(out.success).toBe(false);
  });
});

describe("cashierDayResponse", () => {
  const VALID = {
    outletId: "01890abc-1234-7def-8000-000000000001",
    businessDate: "2026-05-29",
    rows: [
      {
        cashierStaffId: "01890abc-1234-7def-8000-000000000010",
        cashierName: "Siti Rahayu",
        saleCount: 5,
        grossIdr: 125_000,
        netIdr: 100_000,
        voidCount: 1,
        voidIdr: 25_000,
        tenderMix: [
          { method: "cash" as const, amountIdr: 60_000, count: 3 },
          { method: "qris_dynamic" as const, amountIdr: 40_000, count: 2 },
        ],
        drawerExpectedIdr: 160_000,
      },
    ],
    totals: {
      saleCount: 5,
      grossIdr: 125_000,
      netIdr: 100_000,
      voidCount: 1,
      voidIdr: 25_000,
      tenderMix: [
        { method: "cash" as const, amountIdr: 60_000, count: 3 },
        { method: "qris_dynamic" as const, amountIdr: 40_000, count: 2 },
      ],
      drawerExpectedIdr: 160_000,
    },
  };

  it("accepts a populated response", () => {
    const out = cashierDayResponse.safeParse(VALID);
    expect(out.success).toBe(true);
  });

  it("accepts the empty-day canonical zero shape", () => {
    const out = cashierDayResponse.safeParse({
      outletId: VALID.outletId,
      businessDate: VALID.businessDate,
      rows: [],
      totals: {
        saleCount: 0,
        grossIdr: 0,
        netIdr: 0,
        voidCount: 0,
        voidIdr: 0,
        tenderMix: [],
        drawerExpectedIdr: null,
      },
    });
    expect(out.success).toBe(true);
  });

  it("accepts a row with null drawerExpectedIdr (no shift opened)", () => {
    const out = cashierDayResponse.safeParse({
      ...VALID,
      rows: [{ ...VALID.rows[0], drawerExpectedIdr: null }],
      totals: { ...VALID.totals, drawerExpectedIdr: null },
    });
    expect(out.success).toBe(true);
  });

  /**
   * KASA-385 — cross-midnight void overhang. Cashier A sells Rp 50k on
   * day-(N-1), is off on day-N, A's sale is voided on day-N. The day-N
   * report attributes the void to A (KASA-122 PR2) so A's row carries
   * `grossIdr=0`, `voidIdr=50000`, `netIdr=-50000` and the totals
   * inherit the negative net. Schema must round-trip the row + totals.
   */
  it("accepts a row whose netIdr is negative (cross-midnight void overhang)", () => {
    const out = cashierDayResponse.safeParse({
      outletId: VALID.outletId,
      businessDate: VALID.businessDate,
      rows: [
        {
          cashierStaffId: "01890abc-1234-7def-8000-000000000020",
          cashierName: "Cashier A",
          saleCount: 0,
          grossIdr: 0,
          netIdr: -50_000,
          voidCount: 1,
          voidIdr: 50_000,
          tenderMix: [],
          drawerExpectedIdr: null,
        },
      ],
      totals: {
        saleCount: 0,
        grossIdr: 0,
        netIdr: -50_000,
        voidCount: 1,
        voidIdr: 50_000,
        tenderMix: [],
        drawerExpectedIdr: null,
      },
    });
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.rows[0]?.netIdr).toBe(-50_000);
      expect(out.data.totals.netIdr).toBe(-50_000);
    }
  });

  it("still rejects a negative grossIdr or voidIdr (only netIdr is signed)", () => {
    const negGross = cashierDayResponse.safeParse({
      ...VALID,
      rows: [{ ...VALID.rows[0], grossIdr: -1 }],
    });
    expect(negGross.success).toBe(false);

    const negVoid = cashierDayResponse.safeParse({
      ...VALID,
      totals: { ...VALID.totals, voidIdr: -1 },
    });
    expect(negVoid.success).toBe(false);
  });
});
