import { describe, expect, it } from "vitest";
import {
  bomPullResponse,
  itemPullResponse,
  outletPullResponse,
  saleSubmitRequest,
  saleSubmitTender,
  stockLedgerPullQuery,
  stockLedgerPullResponse,
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

  it("requires outletId on stockLedgerPullQuery and clamps limit to int 1..500", () => {
    expect(() => stockLedgerPullQuery.parse({})).toThrow();
    expect(() =>
      stockLedgerPullQuery.parse({
        outletId: "018f9c1a-4b2e-7c00-b000-000000000010",
        limit: 0,
      }),
    ).toThrow();
    expect(() =>
      stockLedgerPullQuery.parse({
        outletId: "018f9c1a-4b2e-7c00-b000-000000000010",
        limit: 501,
      }),
    ).toThrow();
    const ok = stockLedgerPullQuery.parse({
      outletId: "018f9c1a-4b2e-7c00-b000-000000000010",
      limit: 100,
      updatedAfter: "2026-04-24T01:00:00Z",
    });
    expect(ok.limit).toBe(100);
  });

  it("accepts a stock-ledger pull envelope with one signed-delta row", () => {
    const parsed = stockLedgerPullResponse.parse({
      records: [
        {
          id: "018f9c1a-4b2e-7c00-b000-000000000020",
          outletId: "018f9c1a-4b2e-7c00-b000-000000000021",
          itemId: "018f9c1a-4b2e-7c00-b000-000000000022",
          delta: -15,
          reason: "sale",
          refType: "sale",
          refId: "018f9c1a-4b2e-7c00-b000-000000000023",
          occurredAt: "2026-04-24T01:00:00Z",
        },
      ],
      nextCursor: "2026-04-24T01:00:00Z",
      nextPageToken: null,
    });
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.delta).toBe(-15);
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

  // KASA-151: `synthetic` is reserved for the KASA-71 uptime probe. It must
  // pass schema validation like any other tender so the probe exercises the
  // real submit path; the POS UI is never expected to emit it.
  it("accepts a synthetic tender (KASA-71 uptime probe)", () => {
    const parsed = saleSubmitTender.parse({
      method: "synthetic",
      amountIdr: 1,
      reference: null,
    });
    expect(parsed.method).toBe("synthetic");
  });
});

describe("saleSubmitRequest", () => {
  const baseRequest = {
    localSaleId: "018f9c1a-4b2e-7c00-b000-000000000099",
    outletId: "018f9c1a-4b2e-7c00-b000-000000000001",
    clerkId: "018f9c1a-4b2e-7c00-b000-0000000000aa",
    businessDate: "2026-05-20",
    createdAt: "2026-05-20T10:00:00+07:00",
    subtotalIdr: 35_000,
    discountIdr: 0,
    totalIdr: 35_000,
    items: [
      {
        itemId: "018f9c1a-4b2e-7c00-b000-0000000000ff",
        bomId: null,
        quantity: 1,
        uomId: "018f9c1a-4b2e-7c00-b000-0000000000cc",
        unitPriceIdr: 35_000,
        lineTotalIdr: 35_000,
      },
    ],
  };

  it("accepts a split tender (cash 20k + qris 15k) that sums to total", () => {
    const parsed = saleSubmitRequest.parse({
      ...baseRequest,
      tenders: [
        { method: "cash", amountIdr: 20_000, reference: null },
        { method: "qris", amountIdr: 15_000, reference: "ref-1" },
      ],
    });
    expect(parsed.tenders).toHaveLength(2);
  });

  // KASA-310 — server-side belt-and-braces against under-tender. A
  // multi-tender submit that doesn't cover the bill must 422 at the
  // route boundary, not silently land in `tenders`.
  it("rejects a split tender whose legs do not cover the total", () => {
    expect(() =>
      saleSubmitRequest.parse({
        ...baseRequest,
        tenders: [
          { method: "cash", amountIdr: 10_000, reference: null },
          { method: "qris", amountIdr: 15_000, reference: "ref-1" },
        ],
      }),
    ).toThrow(/cover the sale total/);
  });

  it("still accepts a single cash tender that overpays (change due)", () => {
    const parsed = saleSubmitRequest.parse({
      ...baseRequest,
      tenders: [{ method: "cash", amountIdr: 50_000, reference: null }],
    });
    expect(parsed.tenders[0]?.amountIdr).toBe(50_000);
  });
});
