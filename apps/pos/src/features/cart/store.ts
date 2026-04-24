import { create } from "zustand";
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
  type CartState,
} from "./reducer.ts";
import type { AddLineInput, CartLine, CartTotals } from "./types.ts";

export interface CartStore {
  lines: readonly CartLine[];
  discountIdr: CartState["discountIdr"];
  addLine(input: AddLineInput): void;
  incrementLine(itemId: string): void;
  decrementLine(itemId: string): void;
  setLineQuantity(itemId: string, quantity: number): void;
  removeLine(itemId: string): void;
  clear(): void;
  totals(): CartTotals;
  count(): number;
}

export const useCartStore = create<CartStore>((set, get) => ({
  lines: emptyCart.lines,
  discountIdr: emptyCart.discountIdr,
  addLine: (input) => set((s) => addLine({ lines: s.lines, discountIdr: s.discountIdr }, input)),
  incrementLine: (itemId) =>
    set((s) => incrementLine({ lines: s.lines, discountIdr: s.discountIdr }, itemId)),
  decrementLine: (itemId) =>
    set((s) => decrementLine({ lines: s.lines, discountIdr: s.discountIdr }, itemId)),
  setLineQuantity: (itemId, quantity) =>
    set((s) => setLineQuantity({ lines: s.lines, discountIdr: s.discountIdr }, itemId, quantity)),
  removeLine: (itemId) =>
    set((s) => removeLine({ lines: s.lines, discountIdr: s.discountIdr }, itemId)),
  clear: () => set((s) => clearCart({ lines: s.lines, discountIdr: s.discountIdr })),
  totals: () => totals({ lines: get().lines, discountIdr: get().discountIdr }),
  count: () => lineCount({ lines: get().lines, discountIdr: get().discountIdr }),
}));

export function _resetCartStoreForTest(): void {
  useCartStore.setState({ lines: emptyCart.lines, discountIdr: emptyCart.discountIdr });
}
