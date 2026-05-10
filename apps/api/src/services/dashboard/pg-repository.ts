import { type SQL, and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { items } from "../../db/schema/items.js";
import { saleItems, sales } from "../../db/schema/sales.js";
import { tenders } from "../../db/schema/tenders.js";
import { DASHBOARD_TOP_ITEMS_LIMIT, type DashboardRepository } from "./repository.js";
import type {
  DashboardItemRow,
  DashboardSummary,
  DashboardSummaryInput,
  DashboardTenderSlice,
} from "./types.js";

/**
 * Drizzle-backed `DashboardRepository` (KASA-237).
 *
 * The aggregator runs four independent SQL queries — headline tile sums,
 * tender mix, top items by revenue, top items by quantity — instead of
 * pulling sale rows into the application and looping over them. Each query
 * predicates on `(merchant_id, business_date, status, synthetic, voided)`
 * with an optional `outlet_id` filter, hitting the existing
 * `sales_outlet_business_date_idx` (KASA-21) on outlet-scoped runs and a
 * full merchant scan on owner runs over multiple outlets.
 *
 * The two leaderboards are independent `ORDER BY ... LIMIT N` round-trips:
 * picking the top-N by revenue and resorting that buffer in JS would silently
 * drop high-volume / low-revenue items (e.g. air mineral) from the by-quantity
 * leaderboard whenever they fall outside the revenue top-N. Two separate
 * top-N queries cost one extra round-trip but produce the correct shape on
 * both axes.
 */
export class PgDashboardRepository implements DashboardRepository {
  constructor(private readonly db: Database) {}

  async getDashboardSummary(input: DashboardSummaryInput): Promise<DashboardSummary> {
    const baseSaleFilter = and(
      eq(sales.merchantId, input.merchantId),
      gte(sales.businessDate, input.from),
      lte(sales.businessDate, input.to),
      eq(sales.status, "finalised"),
      eq(sales.synthetic, false),
      isNull(sales.voidedAt),
      input.outletId !== null ? eq(sales.outletId, input.outletId) : undefined,
    );

    const headlineRows = await this.db
      .select({
        grossIdr: sql<string>`COALESCE(SUM(${sales.totalIdr}), 0)`.as("gross_idr"),
        taxIdr: sql<string>`COALESCE(SUM(${sales.taxIdr}), 0)`.as("tax_idr"),
        saleCount: sql<string>`COUNT(*)`.as("sale_count"),
      })
      .from(sales)
      .where(baseSaleFilter);
    const headline = headlineRows[0] ?? { grossIdr: "0", taxIdr: "0", saleCount: "0" };

    const tenderRows = await this.db
      .select({
        method: tenders.method,
        amountIdr: sql<string>`COALESCE(SUM(${tenders.amountIdr}), 0)`.as("amount_idr"),
        count: sql<string>`COUNT(*)`.as("count"),
      })
      .from(tenders)
      .innerJoin(sales, eq(sales.id, tenders.saleId))
      .where(baseSaleFilter)
      .groupBy(tenders.method);

    const tenderMix: DashboardTenderSlice[] = [];
    for (const row of tenderRows) {
      // Filter at the repo layer, not in WHERE: keeping the WHERE clause
      // identical across the queries means the planner shares cache entries
      // and the EXPLAIN-asserting test (deferred) does not need to reason
      // about a per-query predicate fork.
      if (row.method === "cash" || row.method === "qris_dynamic" || row.method === "qris_static") {
        tenderMix.push({
          method: row.method,
          amountIdr: Number(row.amountIdr),
          count: Number(row.count),
        });
      }
    }
    tenderMix.sort((a, b) => b.amountIdr - a.amountIdr || a.method.localeCompare(b.method));

    const topItemsByRevenue = await this.selectTopItems({
      baseSaleFilter,
      orderBy: sql`revenue_idr DESC`,
    });
    const topItemsByQuantity = await this.selectTopItems({
      baseSaleFilter,
      orderBy: sql`quantity DESC`,
    });

    return {
      grossIdr: Number(headline.grossIdr),
      taxIdr: Number(headline.taxIdr),
      saleCount: Number(headline.saleCount),
      tenderMix,
      topItemsByRevenue,
      topItemsByQuantity,
    };
  }

  private async selectTopItems(args: {
    baseSaleFilter: SQL | undefined;
    orderBy: SQL;
  }): Promise<DashboardItemRow[]> {
    const rows = await this.db
      .select({
        itemId: items.id,
        name: items.name,
        revenueIdr: sql<string>`COALESCE(SUM(${saleItems.lineTotalIdr}), 0)`.as("revenue_idr"),
        quantity: sql<string>`COALESCE(SUM(${saleItems.quantity}), 0)`.as("quantity"),
      })
      .from(saleItems)
      .innerJoin(sales, eq(sales.id, saleItems.saleId))
      .innerJoin(items, eq(items.id, saleItems.itemId))
      .where(args.baseSaleFilter)
      .groupBy(items.id, items.name)
      .orderBy(args.orderBy, items.id)
      .limit(DASHBOARD_TOP_ITEMS_LIMIT);

    return rows.map((r) => ({
      itemId: r.itemId,
      name: r.name,
      revenueIdr: Number(r.revenueIdr),
      quantity: Number(r.quantity),
    }));
  }
}
