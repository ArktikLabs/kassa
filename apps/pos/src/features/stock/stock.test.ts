import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toRupiah } from "../../shared/money/index.ts";
import { createRepos, type Database, type Repos, stockSnapshotKey } from "../../data/db/index.ts";
import { type KassaDexie, openKassaDb } from "../../data/db/schema.ts";
import { explodeLines, getSnapshotFor } from "./index.ts";

let counter = 0;
function nextDbName(): string {
  counter += 1;
  return `kassa-stock-${counter}-${Math.random().toString(36).slice(2, 10)}`;
}

const OUTLET_A = "22222222-2222-7222-8222-222222222222";
const OUTLET_B = "22222222-2222-7222-8222-222222222299";
const UOM = "55555555-5555-7555-8555-555555555555";
const ITEM_COFFEE = "44444444-4444-7444-8444-444444444444";
const ITEM_BEANS = "44444444-4444-7444-8444-444444444401";
const ITEM_MILK = "44444444-4444-7444-8444-444444444402";
const ITEM_WATER = "44444444-4444-7444-8444-444444444403";
const ITEM_NONTRACKED = "44444444-4444-7444-8444-444444444404";
const BOM_COFFEE = "66666666-6666-7666-8666-666666666601";

interface Fixture {
  name: string;
  db: KassaDexie;
  repos: Repos;
  database: Database;
}

async function setup(): Promise<Fixture> {
  const name = nextDbName();
  const db = await openKassaDb(name);
  const repos = createRepos(db);
  const database: Database = { db, repos, close: () => {} };

  await repos.items.upsertMany([
    {
      id: ITEM_COFFEE,
      code: "KP-001",
      name: "Kopi Susu",
      priceIdr: toRupiah(25_000),
      uomId: UOM,
      bomId: BOM_COFFEE,
      // BOM parent — not stock-tracked itself. Inventory moves at the component level.
      isStockTracked: false,
      taxRate: 11,
      isActive: true,
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
    {
      id: ITEM_BEANS,
      code: "BN-001",
      name: "Biji Kopi",
      priceIdr: toRupiah(0),
      uomId: UOM,
      bomId: null,
      isStockTracked: true,
      taxRate: 11,
      isActive: true,
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
    {
      id: ITEM_MILK,
      code: "MK-001",
      name: "Susu",
      priceIdr: toRupiah(0),
      uomId: UOM,
      bomId: null,
      isStockTracked: true,
      taxRate: 11,
      isActive: true,
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
    {
      id: ITEM_WATER,
      code: "WT-001",
      name: "Air",
      priceIdr: toRupiah(0),
      uomId: UOM,
      bomId: null,
      isStockTracked: true,
      taxRate: 11,
      isActive: true,
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
    {
      id: ITEM_NONTRACKED,
      code: "SV-001",
      name: "Jasa Pembungkus",
      priceIdr: toRupiah(2_000),
      uomId: UOM,
      bomId: null,
      isStockTracked: false,
      taxRate: 11,
      isActive: true,
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
  ]);
  await repos.boms.upsertMany([
    {
      id: BOM_COFFEE,
      itemId: ITEM_COFFEE,
      components: [
        { componentItemId: ITEM_BEANS, quantity: 15, uomId: UOM },
        { componentItemId: ITEM_MILK, quantity: 120, uomId: UOM },
        { componentItemId: ITEM_WATER, quantity: 60, uomId: UOM },
      ],
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
  ]);
  await repos.stockSnapshot.upsertMany([
    {
      key: stockSnapshotKey(OUTLET_A, ITEM_BEANS),
      outletId: OUTLET_A,
      itemId: ITEM_BEANS,
      onHand: 500,
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
    {
      key: stockSnapshotKey(OUTLET_B, ITEM_BEANS),
      outletId: OUTLET_B,
      itemId: ITEM_BEANS,
      onHand: 200,
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
  ]);

  return { name, db, repos, database };
}

async function teardown(fx: Fixture): Promise<void> {
  fx.db.close();
  await Dexie.delete(fx.name);
}

describe("features/stock", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await setup();
  });

  afterEach(async () => {
    await teardown(fx);
  });

  describe("getSnapshotFor", () => {
    it("returns the outlet-scoped snapshot for an item code", async () => {
      const snap = await getSnapshotFor(fx.database, "BN-001", OUTLET_A);
      expect(snap?.onHand).toBe(500);
    });

    it("is per-outlet — the same code resolves to a different row per outlet", async () => {
      const a = await getSnapshotFor(fx.database, "BN-001", OUTLET_A);
      const b = await getSnapshotFor(fx.database, "BN-001", OUTLET_B);
      expect(a?.onHand).toBe(500);
      expect(b?.onHand).toBe(200);
    });

    it("returns undefined for an unknown item code", async () => {
      const snap = await getSnapshotFor(fx.database, "XX-404", OUTLET_A);
      expect(snap).toBeUndefined();
    });

    it("returns undefined when the code exists but the outlet has no snapshot row", async () => {
      const snap = await getSnapshotFor(fx.database, "MK-001", OUTLET_A);
      expect(snap).toBeUndefined();
    });
  });

  describe("explodeLines", () => {
    it("explodes a BOM-backed line into its components", async () => {
      const items = await fx.repos.items.getById(ITEM_COFFEE);
      const itemById = new Map([[ITEM_COFFEE, items!]]);
      const moves = await explodeLines(
        fx.database,
        [{ itemId: ITEM_COFFEE, quantity: 2 }],
        itemById,
      );
      expect(moves).toEqual(
        expect.arrayContaining([
          { itemId: ITEM_BEANS, quantity: 30 },
          { itemId: ITEM_MILK, quantity: 240 },
          { itemId: ITEM_WATER, quantity: 120 },
        ]),
      );
      expect(moves).toHaveLength(3);
      // The BOM parent is never in the move list.
      expect(moves.find((m) => m.itemId === ITEM_COFFEE)).toBeUndefined();
    });

    it("decrements non-BOM tracked items directly", async () => {
      const beans = await fx.repos.items.getById(ITEM_BEANS);
      const moves = await explodeLines(
        fx.database,
        [{ itemId: ITEM_BEANS, quantity: 7 }],
        new Map([[ITEM_BEANS, beans!]]),
      );
      expect(moves).toEqual([{ itemId: ITEM_BEANS, quantity: 7 }]);
    });

    it("skips items that have neither a BOM nor isStockTracked", async () => {
      const svc = await fx.repos.items.getById(ITEM_NONTRACKED);
      const moves = await explodeLines(
        fx.database,
        [{ itemId: ITEM_NONTRACKED, quantity: 1 }],
        new Map([[ITEM_NONTRACKED, svc!]]),
      );
      expect(moves).toEqual([]);
    });

    it("coalesces duplicate component ids across multiple cart lines", async () => {
      // Two cups of Kopi Susu + one bag of beans sold on the side should
      // produce a single ITEM_BEANS move = 15*2 + 1 = 31.
      const coffee = await fx.repos.items.getById(ITEM_COFFEE);
      const beans = await fx.repos.items.getById(ITEM_BEANS);
      const itemById = new Map([
        [ITEM_COFFEE, coffee!],
        [ITEM_BEANS, beans!],
      ]);
      const moves = await explodeLines(
        fx.database,
        [
          { itemId: ITEM_COFFEE, quantity: 2 },
          { itemId: ITEM_BEANS, quantity: 1 },
        ],
        itemById,
      );
      const beansMove = moves.find((m) => m.itemId === ITEM_BEANS);
      expect(beansMove?.quantity).toBe(15 * 2 + 1);
      // Each exploded itemId appears exactly once.
      const ids = moves.map((m) => m.itemId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
