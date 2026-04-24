import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import type { Database } from "../../data/db/index.ts";
import type { Outlet, PendingSale } from "../../data/db/types.ts";
import { getDatabase } from "../../data/db/index.ts";

export interface PendingSaleView {
  sale: PendingSale | undefined;
  outlet: Outlet | undefined;
  ready: boolean;
}

/**
 * Live subscription to a single pending_sale row + its outlet. Returns
 * `ready=false` until Dexie finishes the first tick so the receipt screen
 * can show a skeleton instead of a flash-of-empty-state.
 */
export function usePendingSale(localSaleId: string): PendingSaleView {
  const [db, setDb] = useState<Database | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    getDatabase()
      .then((database) => {
        if (!cancelled) setDb(database);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const view = useLiveQuery(
    async () => {
      if (!db) return undefined;
      const sale = await db.repos.pendingSales.getById(localSaleId);
      const outlet = sale
        ? await db.repos.outlets.getById(sale.outletId)
        : undefined;
      return { sale, outlet };
    },
    [db, localSaleId],
  );

  return {
    sale: view?.sale,
    outlet: view?.outlet,
    ready: db !== null && view !== undefined,
  };
}
