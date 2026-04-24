import type { Rupiah } from "../../shared/money/index.ts";

export interface CartLine {
  itemId: string;
  name: string;
  unitPriceIdr: Rupiah;
  quantity: number;
  lineTotalIdr: Rupiah;
}

export interface CartTotals {
  subtotalIdr: Rupiah;
  discountIdr: Rupiah;
  totalIdr: Rupiah;
}

export interface AddLineInput {
  itemId: string;
  name: string;
  unitPriceIdr: Rupiah;
  quantity?: number;
}
