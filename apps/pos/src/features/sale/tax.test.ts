import { describe, expect, it } from "vitest";
import { toRupiah } from "../../shared/money/index.ts";
import { computeLineTaxIdr, computeSaleTaxIdr } from "./tax.ts";

/*
 * KASA-218 — PWA-side PPN computation. Mirrors the API helper of the same
 * name so the receipt preview matches the server-authoritative `taxIdr`
 * returned by `/v1/sales/submit`. The acceptance number lives in the API
 * test (`apps/api/test/sales-tax.test.ts`); this file focuses on the local
 * formula and the cart-level summation that the receipt depends on.
 */

describe("computeLineTaxIdr (POS unit)", () => {
  it("Rp 11,000 @ 11% inclusive → 1090 (matches server)", () => {
    expect(computeLineTaxIdr(11_000, 11, true)).toBe(1090);
  });

  it("Rp 10,000 @ 11% exclusive → 1100", () => {
    expect(computeLineTaxIdr(10_000, 11, false)).toBe(1100);
  });

  it("zero rate or zero amount contributes nothing", () => {
    expect(computeLineTaxIdr(11_000, 0, true)).toBe(0);
    expect(computeLineTaxIdr(0, 11, true)).toBe(0);
  });
});

describe("computeSaleTaxIdr", () => {
  const itemA = { taxRate: 11 };
  const itemB = { taxRate: 11 };
  const items = new Map([
    ["A", itemA],
    ["B", itemB],
  ]);

  it("sums per-line tax (per-line round, then sum)", () => {
    const total = computeSaleTaxIdr(
      [
        { itemId: "A", lineTotalIdr: toRupiah(11_000) },
        { itemId: "B", lineTotalIdr: toRupiah(22_000) },
      ],
      items,
      true,
    );
    // 1090 + 2180 = 3270
    expect(total).toBe(3270);
  });

  it("contributes 0 for lines whose item is missing from the catalog map", () => {
    const total = computeSaleTaxIdr(
      [{ itemId: "MISSING", lineTotalIdr: toRupiah(11_000) }],
      items,
      true,
    );
    expect(total).toBe(0);
  });

  it("defaults to inclusive mode when no flag is passed", () => {
    const total = computeSaleTaxIdr([{ itemId: "A", lineTotalIdr: toRupiah(11_000) }], items);
    expect(total).toBe(1090);
  });
});
