import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import type { Database } from "../../data/db/index.ts";
import type { Bom, Item, StockSnapshot } from "../../data/db/types.ts";
import { getDatabase } from "../../data/db/index.ts";

export interface CatalogTileData {
  item: Item;
  outOfStock: boolean;
}

interface CatalogQueryResult {
  tiles: readonly CatalogTileData[];
  items: readonly Item[];
  stockByItem: Readonly<Record<string, StockSnapshot | undefined>>;
}

const EMPTY_RESULT: CatalogQueryResult = {
  tiles: [],
  items: [],
  stockByItem: {},
};

/**
 * Decide whether a catalog tile should render `Habis`.
 *
 * Three shapes:
 *   - stock-tracked item -> snapshot.onHand <= 0
 *   - BOM-parent (untracked, has bomId) -> any component snapshot < component.quantity
 *     (server `sale.submit` is still the source of truth for oversell rejection)
 *   - everything else -> sellable
 *
 * Per KASA-112 v0 scope: one BOM level only; component-of-component recursion
 * is intentionally out of scope.
 */
export function tileOutOfStock(
  item: Item,
  stockByItem: Readonly<Record<string, StockSnapshot | undefined>>,
  bomById: ReadonlyMap<string, Bom>,
): boolean {
  if (item.isStockTracked) {
    return (stockByItem[item.id]?.onHand ?? 0) <= 0;
  }
  if (item.bomId === null) return false;
  const bom = bomById.get(item.bomId);
  if (!bom || bom.components.length === 0) return false;
  return bom.components.some(
    (component) => (stockByItem[component.componentItemId]?.onHand ?? 0) < component.quantity,
  );
}

export function useCatalog(): {
  tiles: readonly CatalogTileData[];
  ready: boolean;
} {
  const [db, setDb] = useState<Database | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    getDatabase()
      .then((database) => {
        if (!cancelled) setDb(database);
      })
      .catch(() => {
        // sync-provider already reports open errors to Sentry.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const result = useLiveQuery<CatalogQueryResult | undefined>(async (): Promise<
    CatalogQueryResult | undefined
  > => {
    if (!db) return undefined;
    const items = await db.repos.items.listActive(200);
    const outletId = (await db.repos.deviceSecret.get())?.outletId;
    const stockRows = outletId ? await db.repos.stockSnapshot.forOutlet(outletId) : [];
    const stockByItem: Record<string, StockSnapshot | undefined> = {};
    for (const row of stockRows) stockByItem[row.itemId] = row;
    const bomIds = items.map((item) => item.bomId).filter((id): id is string => id !== null);
    const boms = await db.repos.boms.listByIds(bomIds);
    const bomById = new Map(boms.map((bom) => [bom.id, bom]));
    const tiles: CatalogTileData[] = items.map((item) => ({
      item,
      outOfStock: tileOutOfStock(item, stockByItem, bomById),
    }));
    return { tiles, items, stockByItem };
  }, [db]);

  return {
    tiles: result?.tiles ?? EMPTY_RESULT.tiles,
    ready: db !== null && result !== undefined,
  };
}
