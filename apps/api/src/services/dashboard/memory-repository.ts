import { DASHBOARD_TOP_ITEMS_LIMIT, type DashboardRepository } from "./repository.js";
import type {
  DashboardItemRow,
  DashboardSummary,
  DashboardSummaryInput,
  DashboardTenderSlice,
} from "./types.js";

/*
 * Test / dev fake of `DashboardRepository`. Carries the slice of the data
 * model the dashboard summary touches: finalised, non-synthetic, non-voided
 * sales with their tenders and line items, plus item display names. Production
 * deploys bind `PgDashboardRepository` instead.
 *
 * Filtering mirrors the Pg repo's WHERE clause one-for-one — same predicates
 * (merchant, outlet, business_date window, sale status, synthetic, voided)
 * and the same tender method allow-list — so a route-level test exercising
 * this fake stays representative of the production path.
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

export class InMemoryDashboardRepository implements DashboardRepository {
  private readonly sales: SeededSale[] = [];
  private readonly itemsById = new Map<string, SeededItem>();

  seedSale(sale: SeededSale): void {
    this.sales.push(sale);
  }

  seedItem(item: SeededItem): void {
    this.itemsById.set(item.itemId, item);
  }

  async getDashboardSummary(input: DashboardSummaryInput): Promise<DashboardSummary> {
    const matches = this.sales.filter(
      (s) =>
        s.merchantId === input.merchantId &&
        (input.outletId === null || s.outletId === input.outletId) &&
        s.businessDate >= input.from &&
        s.businessDate <= input.to &&
        s.status === "finalised" &&
        s.synthetic === false &&
        s.voided === false,
    );

    let grossIdr = 0;
    let taxIdr = 0;
    const tenderTotals = new Map<
      DashboardTenderSlice["method"],
      { amountIdr: number; count: number }
    >();
    const itemTotals = new Map<string, { revenueIdr: number; quantity: number }>();

    for (const sale of matches) {
      grossIdr += sale.totalIdr;
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

    const tenderMix: DashboardTenderSlice[] = [...tenderTotals.entries()]
      .map(([method, totals]) => ({ method, amountIdr: totals.amountIdr, count: totals.count }))
      .sort((a, b) => b.amountIdr - a.amountIdr || a.method.localeCompare(b.method));

    const allItems: DashboardItemRow[] = [...itemTotals.entries()].map(([itemId, totals]) => ({
      itemId,
      name: this.itemsById.get(itemId)?.name ?? itemId,
      revenueIdr: totals.revenueIdr,
      quantity: totals.quantity,
    }));

    const topItemsByRevenue = [...allItems]
      .sort((a, b) => b.revenueIdr - a.revenueIdr || a.itemId.localeCompare(b.itemId))
      .slice(0, DASHBOARD_TOP_ITEMS_LIMIT);
    const topItemsByQuantity = [...allItems]
      .sort((a, b) => b.quantity - a.quantity || a.itemId.localeCompare(b.itemId))
      .slice(0, DASHBOARD_TOP_ITEMS_LIMIT);

    return {
      grossIdr,
      taxIdr,
      saleCount: matches.length,
      tenderMix,
      topItemsByRevenue,
      topItemsByQuantity,
    };
  }
}
