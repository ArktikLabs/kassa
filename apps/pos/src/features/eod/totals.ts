import type { PendingSale, PendingSaleTender } from "../../data/db/types.ts";
import { toRupiah, type Rupiah } from "../../shared/money/index.ts";

/*
 * Pure reducer that turns a slice of pending_sales into the client-side
 * EOD totals the clerk sees on `/eod`. Everything here is synchronous and
 * stateless — the Dexie query layer decides which rows to feed in.
 *
 * The QRIS classification on the client is coarser than the server's: the
 * outbox only knows `qris`, so we report it under a single "QRIS (belum
 * diverifikasi)" bucket. The server-side breakdown returned on close
 * refines this once reconciliation lands (KASA-74).
 */

export interface EodClientTotals {
  cashIdr: Rupiah;
  qrisUnverifiedIdr: Rupiah;
  cardIdr: Rupiah;
  otherIdr: Rupiah;
  netIdr: Rupiah;
  saleCount: number;
  /** `localSaleId`s of sales that the PWA will submit with the close. */
  clientSaleIds: readonly string[];
}

export interface TotalsInput {
  /** All outbox rows for this (outletId, businessDate), any status. */
  sales: readonly PendingSale[];
  outletId: string;
  businessDate: string;
}

function cashTakenForSale(totalIdr: number, tenders: readonly PendingSaleTender[]): number {
  let nonCash = 0;
  for (const t of tenders) {
    if (t.method !== "cash") nonCash += t.amountIdr as number;
  }
  const cash = totalIdr - nonCash;
  if (cash <= 0) return 0;
  if (cash > totalIdr) return totalIdr;
  return cash;
}

export function computeEodTotals(input: TotalsInput): EodClientTotals {
  let cash = 0;
  let qris = 0;
  let card = 0;
  let other = 0;
  let net = 0;
  const ids: string[] = [];

  for (const sale of input.sales) {
    if (sale.outletId !== input.outletId) continue;
    if (sale.businessDate !== input.businessDate) continue;
    ids.push(sale.localSaleId);
    const total = sale.totalIdr as number;
    net += total;
    cash += cashTakenForSale(total, sale.tenders);
    for (const tender of sale.tenders) {
      const amount = tender.amountIdr as number;
      if (tender.method === "qris") qris += amount;
      else if (tender.method === "card") card += amount;
      else if (tender.method === "other") other += amount;
    }
  }

  return {
    cashIdr: toRupiah(cash),
    qrisUnverifiedIdr: toRupiah(qris),
    cardIdr: toRupiah(card),
    otherIdr: toRupiah(other),
    netIdr: toRupiah(net),
    saleCount: ids.length,
    clientSaleIds: ids,
  };
}
