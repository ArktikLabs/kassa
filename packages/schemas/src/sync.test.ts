import { describe, expect, it } from "vitest";
import {
  bomPullResponse,
  itemPullResponse,
  outletPullResponse,
  saleSubmitTender,
  stockPullResponse,
  uomPullResponse,
} from "./sync.js";

describe("sync wire schemas", () => {
  it("accepts a well-formed outlet pull envelope", () => {
    const parsed = outletPullResponse.parse({
      records: [
        {
          id: "018f9c1a-4b2e-7c00-b000-000000000001",
          code: "JKT-01",
          name: "Jakarta Selatan",
          timezone: "Asia/Jakarta",
          updatedAt: "2026-04-24T01:00:00Z",
        },
      ],
      nextCursor: "2026-04-24T01:00:00Z",
      nextPageToken: null,
    });
    expect(parsed.records).toHaveLength(1);
    expect(parsed.nextCursor).toBe("2026-04-24T01:00:00Z");
  });

  it("rejects negative item price", () => {
    const bad = {
      records: [
        {
          id: "018f9c1a-4b2e-7c00-b000-000000000002",
          code: "ITM01",
          name: "Es teh",
          priceIdr: -1,
          uomId: "018f9c1a-4b2e-7c00-b000-000000000003",
          bomId: null,
          isStockTracked: false,
          isActive: true,
          updatedAt: "2026-04-24T01:00:00Z",
        },
      ],
      nextCursor: null,
      nextPageToken: null,
    };
    expect(() => itemPullResponse.parse(bad)).toThrow();
  });

  it("rejects extra keys via .strict()", () => {
    expect(() =>
      uomPullResponse.parse({
        records: [
          {
            id: "018f9c1a-4b2e-7c00-b000-000000000004",
            code: "pcs",
            name: "pieces",
            updatedAt: "2026-04-24T01:00:00Z",
            surprise: true,
          },
        ],
        nextCursor: null,
        nextPageToken: null,
      }),
    ).toThrow();
  });

  it("requires at least one BOM component", () => {
    const bad = {
      records: [
        {
          id: "018f9c1a-4b2e-7c00-b000-000000000005",
          itemId: "018f9c1a-4b2e-7c00-b000-000000000006",
          components: [],
          updatedAt: "2026-04-24T01:00:00Z",
        },
      ],
      nextCursor: null,
      nextPageToken: null,
    };
    expect(() => bomPullResponse.parse(bad)).toThrow();
  });

  it("accepts empty stock snapshot page with null cursor", () => {
    const parsed = stockPullResponse.parse({
      records: [],
      nextCursor: null,
      nextPageToken: null,
    });
    expect(parsed.records).toEqual([]);
  });
});

describe("saleSubmitTender", () => {
  it("accepts a qris_static tender with buyerRefLast4 and verified=false", () => {
    const parsed = saleSubmitTender.parse({
      method: "qris_static",
      amountIdr: 25_000,
      reference: null,
      verified: false,
      buyerRefLast4: "1234",
    });
    expect(parsed.method).toBe("qris_static");
    expect(parsed.buyerRefLast4).toBe("1234");
  });

  it("rejects a qris_static tender missing buyerRefLast4", () => {
    expect(() =>
      saleSubmitTender.parse({
        method: "qris_static",
        amountIdr: 25_000,
        reference: null,
      }),
    ).toThrow();
  });

  it("rejects a qris_static tender with verified=true", () => {
    expect(() =>
      saleSubmitTender.parse({
        method: "qris_static",
        amountIdr: 25_000,
        reference: null,
        verified: true,
        buyerRefLast4: "1234",
      }),
    ).toThrow();
  });

  it("rejects a buyerRefLast4 that is not exactly 4 digits", () => {
    expect(() =>
      saleSubmitTender.parse({
        method: "qris_static",
        amountIdr: 25_000,
        reference: null,
        buyerRefLast4: "12",
      }),
    ).toThrow();
  });

  it("accepts a cash tender without verified or buyerRefLast4", () => {
    const parsed = saleSubmitTender.parse({
      method: "cash",
      amountIdr: 25_000,
      reference: null,
    });
    expect(parsed.method).toBe("cash");
  });
});
