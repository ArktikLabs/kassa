import { describe, expect, it } from "vitest";
import { toRupiah } from "../../shared/money/index.ts";
import type { PendingSale } from "../../data/db/types.ts";
import { findSaleByReceiptCode, normalizeReceiptCode, receiptCodeFor } from "./receiptCode.ts";

function makeSale(localSaleId: string): PendingSale {
  return {
    localSaleId,
    outletId: "outlet-a",
    clerkId: "device-1",
    businessDate: "2026-05-29",
    createdAt: "2026-05-29T08:00:00.000Z",
    subtotalIdr: toRupiah(10_000),
    discountIdr: toRupiah(0),
    totalIdr: toRupiah(10_000),
    items: [],
    tenders: [],
    status: "synced",
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    serverSaleName: null,
    serverSaleId: null,
    voidedAt: null,
    voidBusinessDate: null,
    voidReason: null,
    voidLocalId: null,
  };
}

describe("receiptCodeFor", () => {
  it("returns the last six chars of the UUIDv7 trailing hex, uppercased", () => {
    expect(receiptCodeFor("018f9c1a-4b2e-7c00-b000-000000abc123")).toBe("ABC123");
  });

  it("does not include hyphens in the derived code (UUIDv7 tail is 12 hex)", () => {
    const code = receiptCodeFor("018f9c1a-4b2e-7c00-b000-deadbeefcafe");
    expect(code).toBe("EFCAFE");
    expect(code).not.toContain("-");
  });

  it("normalises mixed-case localSaleIds to uppercase", () => {
    expect(receiptCodeFor("018f9c1a-4b2e-7c00-b000-AbCdEf012345")).toBe("012345");
  });
});

describe("normalizeReceiptCode", () => {
  it("strips spaces, hyphens, and lower-cases input", () => {
    expect(normalizeReceiptCode("ab-12 3f")).toBe("AB123F");
    expect(normalizeReceiptCode("000abc")).toBe("000ABC");
    expect(normalizeReceiptCode("#000ABC")).toBe("000ABC");
  });

  it("returns null for inputs that cannot be a six-char code", () => {
    expect(normalizeReceiptCode("")).toBeNull();
    expect(normalizeReceiptCode("12345")).toBeNull();
    expect(normalizeReceiptCode("ABCDEFG")).toBeNull();
    // Punctuation-only input collapses to an empty cleaned string.
    expect(normalizeReceiptCode("---")).toBeNull();
  });
});

describe("findSaleByReceiptCode", () => {
  const sales = [
    makeSale("018f9c1a-4b2e-7c00-b000-000000111111"),
    makeSale("018f9c1a-4b2e-7c00-b000-000000222222"),
    makeSale("018f9c1a-4b2e-7c00-b000-000000333333"),
  ];

  it("returns the matching sale by derived receipt code (case-insensitive)", () => {
    const hit = findSaleByReceiptCode(sales, "222222");
    expect(hit?.localSaleId).toBe("018f9c1a-4b2e-7c00-b000-000000222222");
  });

  it("returns null when no sale matches", () => {
    expect(findSaleByReceiptCode(sales, "999999")).toBeNull();
  });

  it("returns null on an empty input set", () => {
    expect(findSaleByReceiptCode([], "111111")).toBeNull();
  });
});
