import { SALES_SUMMARY_TOP_ITEMS_LIMIT } from "@kassa/schemas/salesSummary";
import type { SalesSummaryRepository } from "./repository.js";
import type {
  SalesSummary,
  SalesSummaryGroupRow,
  SalesSummaryInput,
  SalesSummaryItemRow,
  SalesSummaryTenderSlice,
} from "./types.js";

/*
 * Test / dev fake of `SalesSummaryRepository` (KASA-327).
 *
 * Carries the slice of the data model the period summary touches: every
 * sale (finalised, voided, synthetic) with its tenders, line items, and
 * item display names. Filtering mirrors what the Pg repo's WHERE clause
 * will look like — same predicates (merchant, outlet, business_date
 * window, sale status, synthetic, voided) and the same tender method
 * allow-list — so a route-level test exercising this fake stays
 * representative of the production path.
 *
 * Voids (KASA-236) participate in the refund row: a row with
 * `voided=true` is excluded from gross/tax/discount/saleCount and
 * counted under `refundCount` / `refundIdr` using the void's own
 * `voidBusinessDate` (which may straddle a day boundary from the
 * original sale).
 */

interface SeededLine {
  itemId: string;
  quantity: number;
  lineTotalIdr: number;
}

interface SeededTender {
  method: "cash" | "qris_dynamic" | "qris_static";
  amountIdr: number;
}

export interface SeededSale {
  saleId: string;
  merchantId: string;
  outletId: string;
  businessDate: string;
  /** Refund-bucket date when `voided=true`. Defaults to `businessDate`. */
  voidBusinessDate?: string;
  subtotalIdr?: number;
  discountIdr: number;
  totalIdr: number;
  taxIdr: number;
  status: "finalised" | "voided" | "refunded" | "open";
  synthetic: boolean;
  voided: boolean;
  lines: readonly SeededLine[];
  tenders: readonly SeededTender[];
}

export interface SeededItem {
  itemId: string;
  merchantId: string;
  name: string;
}

export interface SeededOutlet {
  outletId: string;
  merchantId: string;
  name: string;
}

export class InMemorySalesSummaryRepository implements SalesSummaryRepository {
  private readonly sales: SeededSale[] = [];
  private readonly itemsById = new Map<string, SeededItem>();
  private readonly outletsById = new Map<string, SeededOutlet>();

  seedSale(sale: SeededSale): void {
    this.sales.push(sale);
  }

  seedItem(item: SeededItem): void {
    this.itemsById.set(item.itemId, item);
  }

  seedOutlet(outlet: SeededOutlet): void {
    this.outletsById.set(outlet.outletId, outlet);
  }

  async getSalesSummary(input: SalesSummaryInput): Promise<SalesSummary> {
    // Two passes: finalised sales feed every headline figure except the
    // refunds row; voided sales feed only the refunds row, attributed to
    // their own `voidBusinessDate` (KASA-236 — a sale rung at 23:55 and
    // voided at 00:05 counts the next day's books).
    const finalised = this.sales.filter(
      (s) =>
        s.merchantId === input.merchantId &&
        (input.outletId === null || s.outletId === input.outletId) &&
        s.businessDate >= input.from &&
        s.businessDate <= input.to &&
        s.status === "finalised" &&
        s.synthetic === false &&
        s.voided === false,
    );
    const refunds = this.sales.filter((s) => {
      if (s.merchantId !== input.merchantId) return false;
      if (input.outletId !== null && s.outletId !== input.outletId) return false;
      if (s.synthetic) return false;
      if (!s.voided) return false;
      const refundDate = s.voidBusinessDate ?? s.businessDate;
      return refundDate >= input.from && refundDate <= input.to;
    });

    let grossIdr = 0;
    let discountIdr = 0;
    let taxIdr = 0;
    let refundIdr = 0;
    const tenderTotals = new Map<
      SalesSummaryTenderSlice["method"],
      { amountIdr: number; count: number }
    >();
    const itemTotals = new Map<string, { revenueIdr: number; quantity: number }>();

    for (const sale of finalised) {
      grossIdr += sale.totalIdr;
      discountIdr += sale.discountIdr;
      taxIdr += sale.taxIdr;
      for (const tender of sale.tenders) {
        const slot = tenderTotals.get(tender.method) ?? { amountIdr: 0, count: 0 };
        slot.amountIdr += tender.amountIdr;
        slot.count += 1;
        tenderTotals.set(tender.method, slot);
      }
      for (const line of sale.lines) {
        const slot = itemTotals.get(line.itemId) ?? { revenueIdr: 0, quantity: 0 };
        slot.revenueIdr += line.lineTotalIdr;
        slot.quantity += line.quantity;
        itemTotals.set(line.itemId, slot);
      }
    }
    for (const sale of refunds) refundIdr += sale.totalIdr;

    const tenderMix: SalesSummaryTenderSlice[] = [...tenderTotals.entries()]
      .map(([method, totals]) => ({ method, amountIdr: totals.amountIdr, count: totals.count }))
      .sort((a, b) => b.amountIdr - a.amountIdr || a.method.localeCompare(b.method));

    const allItems: SalesSummaryItemRow[] = [...itemTotals.entries()].map(([itemId, totals]) => ({
      itemId,
      name: this.itemsById.get(itemId)?.name ?? itemId,
      revenueIdr: totals.revenueIdr,
      quantity: totals.quantity,
    }));

    const topItemsByRevenue = [...allItems]
      .sort((a, b) => b.revenueIdr - a.revenueIdr || a.itemId.localeCompare(b.itemId))
      .slice(0, SALES_SUMMARY_TOP_ITEMS_LIMIT);
    const topItemsByQuantity = [...allItems]
      .sort((a, b) => b.quantity - a.quantity || a.itemId.localeCompare(b.itemId))
      .slice(0, SALES_SUMMARY_TOP_ITEMS_LIMIT);

    const groups = this.buildGroups(input.groupBy, finalised, refunds, allItems);

    return {
      grossIdr,
      discountIdr,
      taxIdr,
      saleCount: finalised.length,
      refundCount: refunds.length,
      refundIdr,
      tenderMix,
      topItemsByRevenue,
      topItemsByQuantity,
      groups,
    };
  }

  private buildGroups(
    groupBy: SalesSummaryInput["groupBy"],
    finalised: readonly SeededSale[],
    refunds: readonly SeededSale[],
    items: readonly SalesSummaryItemRow[],
  ): SalesSummaryGroupRow[] {
    switch (groupBy) {
      case "day":
        return this.groupByDay(finalised, refunds);
      case "outlet":
        return this.groupByOutlet(finalised, refunds);
      case "tender":
        return this.groupByTender(finalised);
      case "item":
        return this.groupByItem(items);
    }
  }

  private groupByDay(
    finalised: readonly SeededSale[],
    refunds: readonly SeededSale[],
  ): SalesSummaryGroupRow[] {
    const buckets = new Map<string, MutableBucket>();
    for (const sale of finalised) {
      const slot = ensureBucket(buckets, sale.businessDate, sale.businessDate);
      slot.grossIdr += sale.totalIdr;
      slot.discountIdr += sale.discountIdr;
      slot.taxIdr += sale.taxIdr;
      slot.saleCount += 1;
    }
    for (const sale of refunds) {
      const date = sale.voidBusinessDate ?? sale.businessDate;
      const slot = ensureBucket(buckets, date, date);
      slot.refundCount += 1;
      slot.refundIdr += sale.totalIdr;
    }
    return finishBuckets(buckets, (a, b) => a.key.localeCompare(b.key));
  }

  private groupByOutlet(
    finalised: readonly SeededSale[],
    refunds: readonly SeededSale[],
  ): SalesSummaryGroupRow[] {
    const buckets = new Map<string, MutableBucket>();
    const labelFor = (outletId: string) => this.outletsById.get(outletId)?.name ?? outletId;
    for (const sale of finalised) {
      const slot = ensureBucket(buckets, sale.outletId, labelFor(sale.outletId));
      slot.grossIdr += sale.totalIdr;
      slot.discountIdr += sale.discountIdr;
      slot.taxIdr += sale.taxIdr;
      slot.saleCount += 1;
    }
    for (const sale of refunds) {
      const slot = ensureBucket(buckets, sale.outletId, labelFor(sale.outletId));
      slot.refundCount += 1;
      slot.refundIdr += sale.totalIdr;
    }
    return finishBuckets(
      buckets,
      (a, b) => b.grossIdr - a.grossIdr || a.label.localeCompare(b.label),
    );
  }

  private groupByTender(finalised: readonly SeededSale[]): SalesSummaryGroupRow[] {
    const buckets = new Map<string, MutableBucket>();
    for (const sale of finalised) {
      for (const tender of sale.tenders) {
        const slot = ensureBucket(buckets, tender.method, tender.method);
        slot.grossIdr += tender.amountIdr;
        slot.saleCount += 1;
      }
    }
    return finishBuckets(buckets, (a, b) => b.grossIdr - a.grossIdr || a.key.localeCompare(b.key));
  }

  private groupByItem(items: readonly SalesSummaryItemRow[]): SalesSummaryGroupRow[] {
    const rows: SalesSummaryGroupRow[] = items.map((item) => ({
      key: item.itemId,
      label: item.name,
      grossIdr: item.revenueIdr,
      discountIdr: 0,
      taxIdr: 0,
      netIdr: item.revenueIdr,
      saleCount: 0,
      refundCount: 0,
      refundIdr: 0,
      quantity: item.quantity,
    }));
    rows.sort((a, b) => b.grossIdr - a.grossIdr || a.label.localeCompare(b.label));
    return rows;
  }
}

interface MutableBucket {
  key: string;
  label: string;
  grossIdr: number;
  discountIdr: number;
  taxIdr: number;
  saleCount: number;
  refundCount: number;
  refundIdr: number;
  quantity: number;
}

function ensureBucket(
  buckets: Map<string, MutableBucket>,
  key: string,
  label: string,
): MutableBucket {
  const existing = buckets.get(key);
  if (existing) return existing;
  const fresh: MutableBucket = {
    key,
    label,
    grossIdr: 0,
    discountIdr: 0,
    taxIdr: 0,
    saleCount: 0,
    refundCount: 0,
    refundIdr: 0,
    quantity: 0,
  };
  buckets.set(key, fresh);
  return fresh;
}

function finishBuckets(
  buckets: Map<string, MutableBucket>,
  sort: (a: SalesSummaryGroupRow, b: SalesSummaryGroupRow) => number,
): SalesSummaryGroupRow[] {
  const rows: SalesSummaryGroupRow[] = [...buckets.values()].map((b) => ({
    key: b.key,
    label: b.label,
    grossIdr: b.grossIdr,
    discountIdr: b.discountIdr,
    taxIdr: b.taxIdr,
    netIdr: b.grossIdr - b.taxIdr,
    saleCount: b.saleCount,
    refundCount: b.refundCount,
    refundIdr: b.refundIdr,
    quantity: b.quantity,
  }));
  rows.sort(sort);
  return rows;
}
