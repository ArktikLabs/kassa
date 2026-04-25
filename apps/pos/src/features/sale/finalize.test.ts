import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toRupiah } from "../../shared/money/index.ts";
import { createRepos, type Repos } from "../../data/db/index.ts";
import { type KassaDexie, openKassaDb } from "../../data/db/schema.ts";
import { totals } from "../cart/reducer.ts";
import type { CartState } from "../cart/reducer.ts";
import { finalizeCashSale, finalizeQrisSale, SaleFinalizeError } from "./finalize.ts";

let counter = 0;
function nextDbName(): string {
  counter += 1;
  return `kassa-finalize-${counter}-${Math.random().toString(36).slice(2, 10)}`;
}

interface Fixture {
  name: string;
  db: KassaDexie;
  repos: Repos;
}

async function setup(): Promise<Fixture> {
  const name = nextDbName();
  const db = await openKassaDb(name);
  const repos = createRepos(db);

  await repos.deviceSecret.set({
    deviceId: "11111111-1111-7111-8111-111111111111",
    outletId: "22222222-2222-7222-8222-222222222222",
    outletName: "Warung Maju",
    merchantId: "33333333-3333-7333-8333-333333333333",
    merchantName: "Toko Maju",
    apiKey: "pk",
    apiSecret: "sk",
    enrolledAt: "2026-04-23T00:00:00.000Z",
  });
  await repos.outlets.upsertMany([
    {
      id: "22222222-2222-7222-8222-222222222222",
      code: "MAIN",
      name: "Warung Maju",
      timezone: "Asia/Jakarta",
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
  ]);
  await repos.items.upsertMany([
    {
      id: "44444444-4444-7444-8444-444444444444",
      code: "KP-001",
      name: "Kopi Susu",
      priceIdr: toRupiah(25_000),
      uomId: "55555555-5555-7555-8555-555555555555",
      bomId: null,
      isStockTracked: true,
      isActive: true,
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
  ]);
  await repos.stockSnapshot.upsertMany([
    {
      key: "",
      outletId: "22222222-2222-7222-8222-222222222222",
      itemId: "44444444-4444-7444-8444-444444444444",
      onHand: 10,
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
  ]);

  return { name, db, repos };
}

async function teardown(fx: Fixture): Promise<void> {
  fx.db.close();
  await Dexie.delete(fx.name);
}

function cartWithKopi(quantity = 2): CartState {
  return {
    lines: [
      {
        itemId: "44444444-4444-7444-8444-444444444444",
        name: "Kopi Susu",
        unitPriceIdr: toRupiah(25_000),
        quantity,
        lineTotalIdr: toRupiah(25_000 * quantity),
      },
    ],
    discountIdr: toRupiah(0),
  };
}

describe("finalizeCashSale", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await setup();
  });

  afterEach(async () => {
    await teardown(fx);
  });

  it("persists a queued pending_sale, decrements stock, and returns change due", async () => {
    const cart = cartWithKopi(2);
    const cartTotals = totals(cart);
    const result = await finalizeCashSale(
      {
        lines: cart.lines,
        totals: cartTotals,
        tenderedIdr: toRupiah(100_000),
      },
      {
        database: { db: fx.db, repos: fx.repos, close: () => {} },
        generateLocalSaleId: () => "01929b2d-1e01-7f00-80aa-000000000001",
        now: () => new Date("2026-04-23T15:30:00+07:00"),
      },
    );

    expect(result.changeDueIdr).toBe(50_000);
    expect(result.sale.businessDate).toBe("2026-04-23");
    expect(result.sale.createdAt).toBe("2026-04-23T08:30:00.000Z");
    expect(result.sale.clerkId).toBe("11111111-1111-7111-8111-111111111111");

    const stored = await fx.repos.pendingSales.getById(result.localSaleId);
    expect(stored?.status).toBe("queued");
    expect(stored?.items).toHaveLength(1);
    expect(stored?.tenders?.[0]?.method).toBe("cash");
    expect(stored?.totalIdr).toBe(50_000);

    const stock = await fx.repos.stockSnapshot.forOutletItem(
      "22222222-2222-7222-8222-222222222222",
      "44444444-4444-7444-8444-444444444444",
    );
    expect(stock?.onHand).toBe(8);
  });

  it("refuses an empty cart", async () => {
    await expect(
      finalizeCashSale(
        {
          lines: [],
          totals: { subtotalIdr: toRupiah(0), discountIdr: toRupiah(0), totalIdr: toRupiah(0) },
          tenderedIdr: toRupiah(0),
        },
        { database: { db: fx.db, repos: fx.repos, close: () => {} } },
      ),
    ).rejects.toBeInstanceOf(SaleFinalizeError);
  });

  it("refuses an under-tender", async () => {
    const cart = cartWithKopi(1);
    await expect(
      finalizeCashSale(
        {
          lines: cart.lines,
          totals: totals(cart),
          tenderedIdr: toRupiah(10_000),
        },
        { database: { db: fx.db, repos: fx.repos, close: () => {} } },
      ),
    ).rejects.toBeInstanceOf(SaleFinalizeError);
  });

  it("handles exact change with zero changeDueIdr", async () => {
    const cart = cartWithKopi(1);
    const result = await finalizeCashSale(
      {
        lines: cart.lines,
        totals: totals(cart),
        tenderedIdr: toRupiah(25_000),
      },
      {
        database: { db: fx.db, repos: fx.repos, close: () => {} },
        generateLocalSaleId: () => "01929b2d-1e02-7f00-80aa-000000000002",
      },
    );
    expect(result.changeDueIdr).toBe(0);
  });

  it("explodes BOM-backed sales into per-component stock decrements", async () => {
    // Shadow the default fixture: set up a Kopi Susu BOM parent (not
    // stock-tracked on its own) with three components the outlet stocks.
    const BOM_ID = "66666666-6666-7666-8666-666666666601";
    const BEANS = "44444444-4444-7444-8444-4444444444aa";
    const MILK = "44444444-4444-7444-8444-4444444444bb";
    const WATER = "44444444-4444-7444-8444-4444444444cc";
    const OUTLET = "22222222-2222-7222-8222-222222222222";

    await fx.repos.items.upsertMany([
      {
        id: "44444444-4444-7444-8444-444444444444",
        code: "KP-001",
        name: "Kopi Susu",
        priceIdr: toRupiah(25_000),
        uomId: "55555555-5555-7555-8555-555555555555",
        bomId: BOM_ID,
        isStockTracked: false,
        isActive: true,
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
      {
        id: BEANS,
        code: "BN-001",
        name: "Biji Kopi",
        priceIdr: toRupiah(0),
        uomId: "55555555-5555-7555-8555-555555555555",
        bomId: null,
        isStockTracked: true,
        isActive: true,
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
      {
        id: MILK,
        code: "MK-001",
        name: "Susu",
        priceIdr: toRupiah(0),
        uomId: "55555555-5555-7555-8555-555555555555",
        bomId: null,
        isStockTracked: true,
        isActive: true,
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
      {
        id: WATER,
        code: "WT-001",
        name: "Air",
        priceIdr: toRupiah(0),
        uomId: "55555555-5555-7555-8555-555555555555",
        bomId: null,
        isStockTracked: true,
        isActive: true,
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
    ]);
    await fx.repos.boms.upsertMany([
      {
        id: BOM_ID,
        itemId: "44444444-4444-7444-8444-444444444444",
        components: [
          { componentItemId: BEANS, quantity: 15, uomId: "55555555-5555-7555-8555-555555555555" },
          { componentItemId: MILK, quantity: 120, uomId: "55555555-5555-7555-8555-555555555555" },
          { componentItemId: WATER, quantity: 60, uomId: "55555555-5555-7555-8555-555555555555" },
        ],
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
    ]);
    await fx.repos.stockSnapshot.upsertMany([
      {
        key: "",
        outletId: OUTLET,
        itemId: BEANS,
        onHand: 500,
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
      {
        key: "",
        outletId: OUTLET,
        itemId: MILK,
        onHand: 1_000,
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
      {
        key: "",
        outletId: OUTLET,
        itemId: WATER,
        onHand: 2_000,
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
    ]);

    const cart = cartWithKopi(2);
    await finalizeCashSale(
      {
        lines: cart.lines,
        totals: totals(cart),
        tenderedIdr: toRupiah(100_000),
      },
      {
        database: { db: fx.db, repos: fx.repos, close: () => {} },
        generateLocalSaleId: () => "01929b2d-1e03-7f00-80aa-000000000003",
      },
    );

    const [beans, milk, water, kopi] = await Promise.all([
      fx.repos.stockSnapshot.forOutletItem(OUTLET, BEANS),
      fx.repos.stockSnapshot.forOutletItem(OUTLET, MILK),
      fx.repos.stockSnapshot.forOutletItem(OUTLET, WATER),
      // The original Kopi Susu snapshot from setup() is still there but the
      // finished-good row must NOT have moved.
      fx.repos.stockSnapshot.forOutletItem(OUTLET, "44444444-4444-7444-8444-444444444444"),
    ]);
    expect(beans?.onHand).toBe(500 - 15 * 2);
    expect(milk?.onHand).toBe(1_000 - 120 * 2);
    expect(water?.onHand).toBe(2_000 - 60 * 2);
    expect(kopi?.onHand).toBe(10); // untouched — BOM parent does not decrement
  });

  it("generates a UUIDv7 localSaleId by default", async () => {
    const cart = cartWithKopi(1);
    const result = await finalizeCashSale(
      {
        lines: cart.lines,
        totals: totals(cart),
        tenderedIdr: toRupiah(25_000),
      },
      { database: { db: fx.db, repos: fx.repos, close: () => {} } },
    );
    expect(result.localSaleId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("finalizeQrisSale", () => {
  let fx: Fixture;
  const LOCAL_SALE_ID = "01929b2d-1e03-7f00-80aa-000000000003";

  beforeEach(async () => {
    fx = await setup();
  });

  afterEach(async () => {
    await teardown(fx);
  });

  it("persists a queued QRIS sale with the Midtrans order id as tender.reference", async () => {
    const cart = cartWithKopi(2);
    const result = await finalizeQrisSale(
      {
        lines: cart.lines,
        totals: totals(cart),
        localSaleId: LOCAL_SALE_ID,
        qrisOrderId: LOCAL_SALE_ID,
      },
      {
        database: { db: fx.db, repos: fx.repos, close: () => {} },
        now: () => new Date("2026-04-23T15:30:00+07:00"),
      },
    );

    expect(result.localSaleId).toBe(LOCAL_SALE_ID);
    expect(result.changeDueIdr).toBe(0);
    expect(result.sale.tenders[0]).toEqual({
      method: "qris",
      amountIdr: 50_000,
      reference: LOCAL_SALE_ID,
    });

    const stored = await fx.repos.pendingSales.getById(result.localSaleId);
    expect(stored?.status).toBe("queued");
    expect(stored?.tenders?.[0]?.method).toBe("qris");
    expect(stored?.tenders?.[0]?.reference).toBe(LOCAL_SALE_ID);
    expect(stored?.totalIdr).toBe(50_000);

    const stock = await fx.repos.stockSnapshot.forOutletItem(
      "22222222-2222-7222-8222-222222222222",
      "44444444-4444-7444-8444-444444444444",
    );
    expect(stock?.onHand).toBe(8);
  });

  it("refuses an empty cart", async () => {
    await expect(
      finalizeQrisSale(
        {
          lines: [],
          totals: { subtotalIdr: toRupiah(0), discountIdr: toRupiah(0), totalIdr: toRupiah(0) },
          localSaleId: LOCAL_SALE_ID,
          qrisOrderId: LOCAL_SALE_ID,
        },
        { database: { db: fx.db, repos: fx.repos, close: () => {} } },
      ),
    ).rejects.toBeInstanceOf(SaleFinalizeError);
  });
});
