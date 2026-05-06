import { describe, expect, it } from "vitest";
import { eodBreakdown, eodCloseRequest, eodCloseResponse, eodMissingSalesDetails } from "./eod.js";

const OUTLET_ID = "01890abc-1234-7def-8000-000000000001";
const SALE_ID = "01890abc-1234-7def-8000-000000000100";
const EOD_ID = "01890abc-1234-7def-8000-000000000200";

describe("eodCloseRequest", () => {
  it("accepts the happy-path zero-variance payload", () => {
    const parsed = eodCloseRequest.parse({
      outletId: OUTLET_ID,
      businessDate: "2026-04-23",
      countedCashIdr: 250_000,
      varianceReason: null,
      clientSaleIds: [SALE_ID],
    });
    expect(parsed.varianceReason).toBeNull();
    expect(parsed.clientSaleIds).toEqual([SALE_ID]);
  });

  it("accepts an empty clientSaleIds array (no-sales day still needs a close)", () => {
    const parsed = eodCloseRequest.parse({
      outletId: OUTLET_ID,
      businessDate: "2026-04-23",
      countedCashIdr: 0,
      varianceReason: null,
      clientSaleIds: [],
    });
    expect(parsed.clientSaleIds).toEqual([]);
  });

  it("rejects a non-ISO business date", () => {
    const result = eodCloseRequest.safeParse({
      outletId: OUTLET_ID,
      businessDate: "23/04/2026",
      countedCashIdr: 0,
      varianceReason: null,
      clientSaleIds: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative countedCashIdr", () => {
    const result = eodCloseRequest.safeParse({
      outletId: OUTLET_ID,
      businessDate: "2026-04-23",
      countedCashIdr: -1,
      varianceReason: null,
      clientSaleIds: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields on the request envelope", () => {
    const result = eodCloseRequest.safeParse({
      outletId: OUTLET_ID,
      businessDate: "2026-04-23",
      countedCashIdr: 0,
      varianceReason: null,
      clientSaleIds: [],
      trailingNote: "hello",
    });
    expect(result.success).toBe(false);
  });
});

describe("eodCloseResponse", () => {
  it("accepts negative variance (cash short)", () => {
    const parsed = eodCloseResponse.parse({
      eodId: EOD_ID,
      outletId: OUTLET_ID,
      businessDate: "2026-04-23",
      closedAt: "2026-04-23T18:00:00+07:00",
      countedCashIdr: 100_000,
      expectedCashIdr: 120_000,
      varianceIdr: -20_000,
      varianceReason: "ada uang kembali lupa diambil",
      breakdown: eodBreakdown.parse({
        saleCount: 2,
        voidCount: 0,
        cashIdr: 120_000,
        qrisDynamicIdr: 0,
        qrisStaticIdr: 0,
        qrisStaticUnverifiedIdr: 0,
        qrisStaticUnverifiedCount: 0,
        cardIdr: 0,
        otherIdr: 0,
        netIdr: 120_000,
        taxIdr: 0,
      }),
    });
    expect(parsed.varianceIdr).toBe(-20_000);
  });
});

describe("eodMissingSalesDetails", () => {
  it("captures missing ids so the PWA can requeue them", () => {
    const parsed = eodMissingSalesDetails.parse({
      expectedCount: 3,
      receivedCount: 2,
      missingSaleIds: [SALE_ID],
    });
    expect(parsed.missingSaleIds).toHaveLength(1);
  });
});
