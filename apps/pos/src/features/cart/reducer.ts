import {
  addRupiah,
  multiplyRupiah,
  subtractRupiah,
  zeroRupiah,
  type Rupiah,
} from "../../shared/money/index.ts";
import type { AddLineInput, CartLine, CartTotals } from "./types.ts";

export interface CartState {
  lines: readonly CartLine[];
  discountIdr: Rupiah;
}

export const emptyCart: CartState = {
  lines: [],
  discountIdr: zeroRupiah,
};

function rebuildLine(line: CartLine, quantity: number): CartLine {
  return {
    ...line,
    quantity,
    lineTotalIdr: multiplyRupiah(line.unitPriceIdr, quantity),
  };
}

export function addLine(state: CartState, input: AddLineInput): CartState {
  const delta = input.quantity ?? 1;
  if (delta <= 0 || !Number.isInteger(delta)) return state;

  const existing = state.lines.find((l) => l.itemId === input.itemId);
  if (existing) {
    const nextQty = existing.quantity + delta;
    return {
      ...state,
      lines: state.lines.map((l) => (l.itemId === input.itemId ? rebuildLine(l, nextQty) : l)),
    };
  }
  const newLine: CartLine = {
    itemId: input.itemId,
    name: input.name,
    unitPriceIdr: input.unitPriceIdr,
    quantity: delta,
    lineTotalIdr: multiplyRupiah(input.unitPriceIdr, delta),
  };
  return { ...state, lines: [...state.lines, newLine] };
}

export function incrementLine(state: CartState, itemId: string): CartState {
  const existing = state.lines.find((l) => l.itemId === itemId);
  if (!existing) return state;
  return {
    ...state,
    lines: state.lines.map((l) => (l.itemId === itemId ? rebuildLine(l, l.quantity + 1) : l)),
  };
}

export function decrementLine(state: CartState, itemId: string): CartState {
  const existing = state.lines.find((l) => l.itemId === itemId);
  if (!existing) return state;
  if (existing.quantity <= 1) {
    return removeLine(state, itemId);
  }
  return {
    ...state,
    lines: state.lines.map((l) => (l.itemId === itemId ? rebuildLine(l, l.quantity - 1) : l)),
  };
}

export function setLineQuantity(state: CartState, itemId: string, quantity: number): CartState {
  if (!Number.isInteger(quantity) || quantity < 0) return state;
  if (quantity === 0) return removeLine(state, itemId);
  const existing = state.lines.find((l) => l.itemId === itemId);
  if (!existing) return state;
  return {
    ...state,
    lines: state.lines.map((l) => (l.itemId === itemId ? rebuildLine(l, quantity) : l)),
  };
}

export function removeLine(state: CartState, itemId: string): CartState {
  return {
    ...state,
    lines: state.lines.filter((l) => l.itemId !== itemId),
  };
}

export function clearCart(state: CartState): CartState {
  return { ...state, lines: [], discountIdr: zeroRupiah };
}

export function totals(state: CartState): CartTotals {
  const subtotal = state.lines.reduce<Rupiah>(
    (acc, l) => addRupiah(acc, l.lineTotalIdr),
    zeroRupiah,
  );
  const discount =
    (state.discountIdr as number) > (subtotal as number) ? subtotal : state.discountIdr;
  const total = subtractRupiah(subtotal, discount);
  return { subtotalIdr: subtotal, discountIdr: discount, totalIdr: total };
}

export function lineCount(state: CartState): number {
  return state.lines.reduce((acc, l) => acc + l.quantity, 0);
}
