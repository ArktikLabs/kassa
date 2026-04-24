import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import type { Database } from "../../data/db/index.ts";
import type { Item, StockSnapshot } from "../../data/db/types.ts";
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
    const tiles: CatalogTileData[] = items.map((item) => ({
      item,
      outOfStock: item.isStockTracked && (stockByItem[item.id]?.onHand ?? 0) <= 0,
    }));
    return { tiles, items, stockByItem };
  }, [db]);

  return {
    tiles: result?.tiles ?? EMPTY_RESULT.tiles,
    ready: db !== null && result !== undefined,
  };
}
