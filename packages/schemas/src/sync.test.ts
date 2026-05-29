import { describe, expect, it } from "vitest";
import {
  bomPullResponse,
  itemPullResponse,
  outletPullResponse,
  outletUpdateRequest,
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

describe("outletUpdateRequest (KASA-367)", () => {
  it("accepts a partial PATCH with only displayName", () => {
    const parsed = outletUpdateRequest.parse({ displayName: "Warung Pusat" });
    expect(parsed.displayName).toBe("Warung Pusat");
  });

  it("accepts null to clear a field", () => {
    const parsed = outletUpdateRequest.parse({ taxId: null });
    expect(parsed.taxId).toBeNull();
  });

  it("accepts a 15-digit NPWP", () => {
    const parsed = outletUpdateRequest.parse({ taxId: "012345678901000" });
    expect(parsed.taxId).toBe("012345678901000");
  });

  it("accepts a 16-digit NPWP (KASA-367 NIK-NPWP unified form)", () => {
    const parsed = outletUpdateRequest.parse({ taxId: "0123456789012345" });
    expect(parsed.taxId).toBe("0123456789012345");
  });

  it("rejects a NPWP that includes formatting punctuation", () => {
    expect(() => outletUpdateRequest.parse({ taxId: "01.234.567.8-901.000" })).toThrow();
  });

  it("rejects a NPWP shorter than 15 digits", () => {
    expect(() => outletUpdateRequest.parse({ taxId: "01234567890" })).toThrow();
  });

  it("rejects a receipt footer line longer than 32 chars", () => {
    expect(() => outletUpdateRequest.parse({ receiptFooterLine1: "x".repeat(33) })).toThrow();
  });

  it("rejects an empty PATCH body", () => {
    expect(() => outletUpdateRequest.parse({})).toThrow();
  });

  it("rejects unknown keys via .strict()", () => {
    expect(() =>
      outletUpdateRequest.parse({ displayName: "ok", logoUrl: "https://example.test" }),
    ).toThrow();
  });
});

describe("outletPullResponse (KASA-367 — branded outlet record)", () => {
  it("accepts an outlet with KASA-367 branding fields", () => {
    const parsed = outletPullResponse.parse({
      records: [
        {
          id: "018f9c1a-4b2e-7c00-b000-000000000001",
          code: "JKT-01",
          name: "Jakarta Selatan",
          timezone: "Asia/Jakarta",
          displayName: "Warung Pusat",
          addressLine1: "Jl. Sudirman No.1",
          addressLine2: "Jakarta",
          taxId: "012345678901000",
          receiptFooterLine1: "Terima kasih atas kunjungan",
          receiptFooterLine2: null,
          updatedAt: "2026-04-24T01:00:00Z",
        },
      ],
      nextCursor: null,
      nextPageToken: null,
    });
    expect(parsed.records[0]?.displayName).toBe("Warung Pusat");
    expect(parsed.records[0]?.taxId).toBe("012345678901000");
  });

  it("accepts an outlet without any KASA-367 branding fields (legacy)", () => {
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
      nextCursor: null,
      nextPageToken: null,
    });
    expect(parsed.records[0]?.displayName).toBeUndefined();
  });
});
