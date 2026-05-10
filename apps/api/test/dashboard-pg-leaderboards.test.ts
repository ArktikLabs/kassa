import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { PgDashboardRepository } from "../src/services/dashboard/pg-repository.js";
import {
  runIfIntegration,
  seedItem,
  seedMerchant,
  seedOutlet,
  seedUom,
  startIntegrationServer,
  type IntegrationHarness,
} from "./helpers/integration-server.js";

/*
 * KASA-237 regression: `PgDashboardRepository` must derive the by-quantity
 * leaderboard from a separate `ORDER BY quantity DESC` query, not by
 * resorting a buffer of revenue-ordered rows. The earlier implementation
 * pulled `2 × DASHBOARD_TOP_ITEMS_LIMIT = 10` rows by revenue and resorted
 * in JS, so a high-volume / low-revenue line (e.g. air mineral) outside the
 * top-10 by revenue could never reach the by-quantity leaderboard.
 *
 * The in-memory repo is correct (it sees every aggregated line), so route-
 * level tests don't catch the divergence — this suite hits real Postgres.
 */

const MERCHANT = "01890abc-1234-7def-8000-00000000aaa1";
const OUTLET = "01890abc-1234-7def-8000-0000aaaa0001";
const STAFF_ID = "01890abc-1234-7def-8000-000000000020";
const UOM = "01890abc-1234-7def-8000-0000c0c0c001";

const TODAY = "2026-04-25";

// 10 high-revenue / low-quantity items + 1 low-revenue / high-quantity item.
// With buffer = 10 the air-mineral item falls outside the revenue top-10 and
// the buggy implementation never includes it in `topItemsByQuantity`.
const HIGH_REV_ITEM_IDS = [
  "01890abc-1234-7def-8000-000011110001",
  "01890abc-1234-7def-8000-000011110002",
  "01890abc-1234-7def-8000-000011110003",
  "01890abc-1234-7def-8000-000011110004",
  "01890abc-1234-7def-8000-000011110005",
  "01890abc-1234-7def-8000-000011110006",
  "01890abc-1234-7def-8000-000011110007",
  "01890abc-1234-7def-8000-000011110008",
  "01890abc-1234-7def-8000-000011110009",
  "01890abc-1234-7def-8000-00001111000a",
] as const;
const AIR_MINERAL_ITEM_ID = "01890abc-1234-7def-8000-00001111000b";

interface SeedSaleArgs {
  saleId: string;
  totalIdr: number;
  lines: { lineId: string; itemId: string; quantity: number; lineTotalIdr: number }[];
}

runIfIntegration("PgDashboardRepository top-N leaderboards (KASA-237 regression)", () => {
  let harness: IntegrationHarness | undefined;
  const h = (): IntegrationHarness => {
    if (!harness) throw new Error("integration harness was not initialised");
    return harness;
  };

  async function seedStaff(): Promise<void> {
    await h().db.execute(
      sql`INSERT INTO staff (id, merchant_id, email, password_hash, role)
          VALUES (${STAFF_ID}, ${MERCHANT}, 'owner@test', 'argon2-stub', 'owner')`,
    );
  }

  async function seedSale(args: SeedSaleArgs): Promise<void> {
    await h().db.execute(
      sql`INSERT INTO sales (
            id, merchant_id, outlet_id, clerk_id, local_sale_id, business_date,
            status, subtotal_idr, total_idr, tax_idr, synthetic
          ) VALUES (
            ${args.saleId}, ${MERCHANT}, ${OUTLET}, ${STAFF_ID}, ${args.saleId},
            ${TODAY}, 'finalised', ${args.totalIdr}, ${args.totalIdr}, 0, false
          )`,
    );
    for (const line of args.lines) {
      await h().db.execute(
        sql`INSERT INTO sale_items (
              id, sale_id, item_id, uom_id, quantity, unit_price_idr, line_total_idr
            ) VALUES (
              ${line.lineId}, ${args.saleId}, ${line.itemId}, ${UOM},
              ${line.quantity}, ${line.lineTotalIdr}, ${line.lineTotalIdr}
            )`,
      );
    }
  }

  beforeAll(async () => {
    harness = await startIntegrationServer();
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.close();
  });

  beforeEach(async () => {
    await h().reset();
  });

  it("includes a high-quantity / low-revenue item in topItemsByQuantity even when it falls outside the revenue top-N", async () => {
    await seedMerchant(h().db, { id: MERCHANT });
    await seedOutlet(h().db, { id: OUTLET, merchantId: MERCHANT, code: "OUT-1" });
    await seedStaff();
    await seedUom(h().db, { id: UOM, merchantId: MERCHANT, code: "PCS" });

    // 10 high-revenue items: each ships once at Rp 100_000.
    for (let i = 0; i < HIGH_REV_ITEM_IDS.length; i++) {
      const itemId = HIGH_REV_ITEM_IDS[i] as string;
      await seedItem(h().db, {
        id: itemId,
        merchantId: MERCHANT,
        code: `HIGH-REV-${i + 1}`,
        name: `High Rev ${i + 1}`,
        priceIdr: 100_000,
        uomId: UOM,
      });
      const saleSuffix = i.toString(16).padStart(4, "0");
      await seedSale({
        saleId: `01890abc-1234-7def-8000-0000aaaa${saleSuffix}`,
        totalIdr: 100_000,
        lines: [
          {
            lineId: `01890abc-1234-7def-8000-0000bbbb${saleSuffix}`,
            itemId,
            quantity: 1,
            lineTotalIdr: 100_000,
          },
        ],
      });
    }

    // Air mineral: low revenue (Rp 100), but very high quantity (50). Falls
    // outside the top-10 by revenue, so the old buffer-then-resort code never
    // sees it on the by-quantity leaderboard. The fix runs a second
    // `ORDER BY quantity DESC` query that picks it up.
    await seedItem(h().db, {
      id: AIR_MINERAL_ITEM_ID,
      merchantId: MERCHANT,
      code: "AIR-MINERAL",
      name: "Air Mineral",
      priceIdr: 100,
      uomId: UOM,
    });
    await seedSale({
      saleId: "01890abc-1234-7def-8000-0000aaaaffff",
      totalIdr: 100,
      lines: [
        {
          lineId: "01890abc-1234-7def-8000-0000bbbbffff",
          itemId: AIR_MINERAL_ITEM_ID,
          quantity: 50,
          lineTotalIdr: 100,
        },
      ],
    });

    const repo = new PgDashboardRepository(h().db);
    const summary = await repo.getDashboardSummary({
      merchantId: MERCHANT,
      outletId: null,
      from: TODAY,
      to: TODAY,
    });

    // Top-by-revenue: any of the 10 high-revenue items, none with quantity > 1.
    expect(summary.topItemsByRevenue).toHaveLength(5);
    for (const row of summary.topItemsByRevenue) {
      expect(row.revenueIdr).toBe(100_000);
      expect(row.quantity).toBe(1);
    }

    // Top-by-quantity must surface the high-volume item even though it is
    // nowhere near the revenue leaderboard. This is the regression.
    expect(summary.topItemsByQuantity[0]).toMatchObject({
      itemId: AIR_MINERAL_ITEM_ID,
      name: "Air Mineral",
      revenueIdr: 100,
      quantity: 50,
    });
  });
});
