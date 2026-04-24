import { describe, expect, it } from "vitest";
import { toRupiah, zeroRupiah } from "../../shared/money/index.ts";
import {
  addLine,
  clearCart,
  decrementLine,
  emptyCart,
  incrementLine,
  lineCount,
  removeLine,
  setLineQuantity,
  totals,
} from "./reducer.ts";

const kopiSusu = {
  itemId: "item-kopi",
  name: "Kopi Susu",
  unitPriceIdr: toRupiah(18000),
};

const rotiBakar = {
  itemId: "item-roti",
  name: "Roti Bakar",
  unitPriceIdr: toRupiah(12500),
};

describe("cart reducer", () => {
  it("starts empty with zero totals", () => {
    const t = totals(emptyCart);
    expect(emptyCart.lines).toHaveLength(0);
    expect(t.subtotalIdr).toBe(0);
    expect(t.totalIdr).toBe(0);
    expect(lineCount(emptyCart)).toBe(0);
  });

  it("adds a new line with quantity 1 by default", () => {
    const s = addLine(emptyCart, kopiSusu);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatchObject({
      itemId: "item-kopi",
      quantity: 1,
      unitPriceIdr: 18000,
      lineTotalIdr: 18000,
    });
  });

  it("increments quantity when adding an existing item", () => {
    let s = addLine(emptyCart, kopiSusu);
    s = addLine(s, kopiSusu);
    s = addLine(s, { ...kopiSusu, quantity: 2 });
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]!.quantity).toBe(4);
    expect(s.lines[0]!.lineTotalIdr).toBe(72000);
  });

  it("ignores addLine with non-positive or non-integer quantity", () => {
    const s = addLine(emptyCart, { ...kopiSusu, quantity: 0 });
    const s2 = addLine(emptyCart, { ...kopiSusu, quantity: -1 });
    const s3 = addLine(emptyCart, { ...kopiSusu, quantity: 1.5 });
    expect(s.lines).toHaveLength(0);
    expect(s2.lines).toHaveLength(0);
    expect(s3.lines).toHaveLength(0);
  });

  it("increments an existing line with inc", () => {
    let s = addLine(emptyCart, kopiSusu);
    s = incrementLine(s, "item-kopi");
    expect(s.lines[0]!.quantity).toBe(2);
    expect(s.lines[0]!.lineTotalIdr).toBe(36000);
  });

  it("ignores inc when item is absent", () => {
    const s = incrementLine(emptyCart, "nope");
    expect(s).toBe(emptyCart);
  });

  it("decrements and drops the line at quantity 1", () => {
    let s = addLine(emptyCart, kopiSusu);
    s = addLine(s, kopiSusu);
    s = decrementLine(s, "item-kopi");
    expect(s.lines[0]!.quantity).toBe(1);
    s = decrementLine(s, "item-kopi");
    expect(s.lines).toHaveLength(0);
  });

  it("setLineQuantity replaces the quantity, removes on zero, ignores negatives", () => {
    let s = addLine(emptyCart, kopiSusu);
    s = setLineQuantity(s, "item-kopi", 5);
    expect(s.lines[0]!.quantity).toBe(5);
    expect(s.lines[0]!.lineTotalIdr).toBe(90000);
    s = setLineQuantity(s, "item-kopi", 0);
    expect(s.lines).toHaveLength(0);
    const back = addLine(emptyCart, kopiSusu);
    expect(setLineQuantity(back, "item-kopi", -1)).toBe(back);
    expect(setLineQuantity(back, "item-kopi", 1.4)).toBe(back);
  });

  it("removes a line explicitly", () => {
    let s = addLine(emptyCart, kopiSusu);
    s = addLine(s, rotiBakar);
    s = removeLine(s, "item-kopi");
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]!.itemId).toBe("item-roti");
  });

  it("clears all lines", () => {
    let s = addLine(emptyCart, kopiSusu);
    s = addLine(s, rotiBakar);
    s = clearCart(s);
    expect(s.lines).toHaveLength(0);
    expect(s.discountIdr).toBe(zeroRupiah);
  });

  it("computes totals across multiple lines in branded Rupiah", () => {
    let s = addLine(emptyCart, { ...kopiSusu, quantity: 2 });
    s = addLine(s, { ...rotiBakar, quantity: 3 });
    const t = totals(s);
    expect(t.subtotalIdr).toBe(2 * 18000 + 3 * 12500);
    expect(t.totalIdr).toBe(t.subtotalIdr);
    expect(Number.isInteger(t.subtotalIdr)).toBe(true);
  });

  it("caps discount at subtotal so total is never negative", () => {
    const s = { ...addLine(emptyCart, kopiSusu), discountIdr: toRupiah(99999) };
    const t = totals(s);
    expect(t.totalIdr).toBe(0);
    expect(t.discountIdr).toBe(t.subtotalIdr);
  });

  it("lineCount sums across lines", () => {
    let s = addLine(emptyCart, { ...kopiSusu, quantity: 2 });
    s = addLine(s, { ...rotiBakar, quantity: 3 });
    expect(lineCount(s)).toBe(5);
  });
});
