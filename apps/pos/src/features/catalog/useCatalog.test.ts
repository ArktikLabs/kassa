import { describe, expect, it } from "vitest";
import { tileOutOfStock } from "./useCatalog.ts";
import { toRupiah } from "../../shared/money/index.ts";
import { stockSnapshotKey, type Bom, type Item, type StockSnapshot } from "../../data/db/types.ts";

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: overrides.id ?? "item-parent",
    code: overrides.code ?? "SKU-PARENT",
    name: overrides.name ?? "Kopi Susu",
    priceIdr: overrides.priceIdr ?? toRupiah(18_000),
    uomId: overrides.uomId ?? "uom-cup",
    bomId: overrides.bomId ?? null,
    isStockTracked: overrides.isStockTracked ?? false,
    taxRate: overrides.taxRate ?? 11,
    availability: overrides.availability ?? "available",
    isActive: overrides.isActive ?? true,
    updatedAt: overrides.updatedAt ?? "2026-04-26T00:00:00.000Z",
  };
}

function makeSnapshot(itemId: string, onHand: number): StockSnapshot {
  return {
    key: stockSnapshotKey("outlet-1", itemId),
    outletId: "outlet-1",
    itemId,
    onHand,
    updatedAt: "2026-04-26T00:00:00.000Z",
  };
}

function indexSnapshots(rows: readonly StockSnapshot[]): Record<string, StockSnapshot | undefined> {
  const map: Record<string, StockSnapshot | undefined> = {};
  for (const row of rows) map[row.itemId] = row;
  return map;
}

describe("tileOutOfStock", () => {
  it("stock-tracked item with onHand <= 0 is out of stock", () => {
    const item = makeItem({ id: "item-1", isStockTracked: true, bomId: null });
    const stock = indexSnapshots([makeSnapshot("item-1", 0)]);
    expect(tileOutOfStock(item, stock, new Map())).toBe(true);
  });

  it("stock-tracked item with positive onHand is sellable", () => {
    const item = makeItem({ id: "item-1", isStockTracked: true, bomId: null });
    const stock = indexSnapshots([makeSnapshot("item-1", 3)]);
    expect(tileOutOfStock(item, stock, new Map())).toBe(false);
  });

  it("BOM parent with one component at 0 is out of stock", () => {
    const parent = makeItem({ id: "parent", isStockTracked: false, bomId: "bom-1" });
    const bom: Bom = {
      id: "bom-1",
      itemId: "parent",
      components: [
        { componentItemId: "milk", quantity: 1, uomId: "uom-ml" },
        { componentItemId: "espresso", quantity: 1, uomId: "uom-shot" },
      ],
      updatedAt: "2026-04-26T00:00:00.000Z",
    };
    const stock = indexSnapshots([makeSnapshot("milk", 0), makeSnapshot("espresso", 50)]);
    expect(tileOutOfStock(parent, stock, new Map([[bom.id, bom]]))).toBe(true);
  });

  it("BOM parent with all components plentiful is sellable", () => {
    const parent = makeItem({ id: "parent", isStockTracked: false, bomId: "bom-1" });
    const bom: Bom = {
      id: "bom-1",
      itemId: "parent",
      components: [
        { componentItemId: "milk", quantity: 1, uomId: "uom-ml" },
        { componentItemId: "espresso", quantity: 1, uomId: "uom-shot" },
      ],
      updatedAt: "2026-04-26T00:00:00.000Z",
    };
    const stock = indexSnapshots([makeSnapshot("milk", 12), makeSnapshot("espresso", 50)]);
    expect(tileOutOfStock(parent, stock, new Map([[bom.id, bom]]))).toBe(false);
  });

  it("BOM parent is out of stock when a component has insufficient onHand for one sale", () => {
    const parent = makeItem({ id: "parent", isStockTracked: false, bomId: "bom-1" });
    // Recipe needs 2 shots of espresso; only 1 in stock.
    const bom: Bom = {
      id: "bom-1",
      itemId: "parent",
      components: [{ componentItemId: "espresso", quantity: 2, uomId: "uom-shot" }],
      updatedAt: "2026-04-26T00:00:00.000Z",
    };
    const stock = indexSnapshots([makeSnapshot("espresso", 1)]);
    expect(tileOutOfStock(parent, stock, new Map([[bom.id, bom]]))).toBe(true);
  });

  it("untracked item with no BOM stays sellable (e.g. service / non-inventory item)", () => {
    const item = makeItem({ id: "item-x", isStockTracked: false, bomId: null });
    expect(tileOutOfStock(item, {}, new Map())).toBe(false);
  });

  it("BOM parent with a missing BOM record falls back to sellable (server is source of truth)", () => {
    const parent = makeItem({ id: "parent", isStockTracked: false, bomId: "bom-missing" });
    expect(tileOutOfStock(parent, {}, new Map())).toBe(false);
  });

  it("KASA-248: ignores `availability` — that flag is owned by the catalog hook, not the inventory derivation", () => {
    // tileOutOfStock answers "does inventory say this is out?". The manual
    // `sold_out` flag is a separate dimension that useCatalog combines into
    // the tile's final greyed state.
    const item = makeItem({
      id: "item-1",
      isStockTracked: false,
      bomId: null,
      availability: "sold_out",
    });
    expect(tileOutOfStock(item, {}, new Map())).toBe(false);
  });
});
