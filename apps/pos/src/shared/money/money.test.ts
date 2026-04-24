import { describe, expect, it } from "vitest";
import {
  addRupiah,
  formatIdr,
  fromNumber,
  InvalidRupiahError,
  isRupiah,
  multiplyRupiah,
  subtractRupiah,
  toRupiah,
  zeroRupiah,
  type Rupiah,
} from "./index.ts";

describe("Rupiah branded type", () => {
  it("accepts non-negative integers via toRupiah", () => {
    const amount = toRupiah(25_000);
    expect(amount).toBe(25_000);
    expect(isRupiah(amount)).toBe(true);
  });

  it("rejects fractional numbers", () => {
    expect(() => toRupiah(25_000.5)).toThrow(InvalidRupiahError);
  });

  it("rejects negative values", () => {
    expect(() => toRupiah(-1)).toThrow(InvalidRupiahError);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => toRupiah(Number.NaN)).toThrow(InvalidRupiahError);
    expect(() => toRupiah(Number.POSITIVE_INFINITY)).toThrow(InvalidRupiahError);
  });

  it("rounds then validates via fromNumber", () => {
    const amount = fromNumber(25_000.49);
    expect(amount).toBe(25_000);
  });

  it("adds and subtracts while keeping the brand", () => {
    const a = toRupiah(10_000);
    const b = toRupiah(2_500);
    expect(addRupiah(a, b)).toBe(12_500);
    expect(subtractRupiah(a, b)).toBe(7_500);
  });

  it("refuses to produce fractional rupiah via subtraction", () => {
    const a = toRupiah(500);
    const b = toRupiah(501);
    expect(() => subtractRupiah(a, b)).toThrow(InvalidRupiahError);
  });

  it("multiplies by a factor and rounds", () => {
    const unit = toRupiah(12_500);
    expect(multiplyRupiah(unit, 3)).toBe(37_500);
    expect(multiplyRupiah(unit, 0.1)).toBe(1_250);
  });

  it("formats as id-ID IDR currency", () => {
    const formatted = formatIdr(toRupiah(125_000));
    expect(formatted).toMatch(/Rp/);
    expect(formatted).toContain("125");
  });

  it("exposes a zero constant", () => {
    expect(zeroRupiah).toBe(0);
    expect(isRupiah(zeroRupiah)).toBe(true);
  });

  it("is a type error to assign a raw number to Rupiah", () => {
    // @ts-expect-error — a plain number must not be assignable to Rupiah.
    const _bad: Rupiah = 1_000;
    // Runtime value still works; the invariant is enforced at compile time.
    expect(_bad).toBe(1_000);
  });

  it("is a type error to pass a number directly to a function that expects Rupiah", () => {
    function needsRupiah(_amount: Rupiah) {
      return _amount;
    }
    // @ts-expect-error — raw numbers are rejected at the call site.
    needsRupiah(500);
    // Valid: wrap first.
    expect(needsRupiah(toRupiah(500))).toBe(500);
  });
});
