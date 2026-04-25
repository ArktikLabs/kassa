import type { Database } from "../../data/db/index.ts";
import type { Item, StockSnapshot } from "../../data/db/types.ts";

/*
 * `features/stock` is the client's read + BOM-explode surface for per-outlet
 * stock. The acceptance criterion for KASA-66 names `getSnapshotFor(itemCode,
 * outletId)` specifically — clerks look up items by the human-readable code
 * they ring up, not by UUID. Callers that already have the itemId should use
 * `database.repos.stockSnapshot.forOutletItem` directly.
 *
 * `explodeLines` is the single source of truth for "which stock rows move on
 * this sale". It is called from `features/sale.finalize` inside the outbox
 * Dexie transaction (ARCHITECTURE §3.1 Flow B) so the optimistic decrement and
 * the pending_sale row commit or rollback together.
 */

export async function getSnapshotFor(
  database: Database,
  itemCode: string,
  outletId: string,
): Promise<StockSnapshot | undefined> {
  const item = await database.repos.items.getByCode(itemCode);
  if (!item) return undefined;
  return database.repos.stockSnapshot.forOutletItem(outletId, item.id);
}

export interface ExplodedStockLine {
  /** The item whose `stock_snapshot` row must be decremented. */
  itemId: string;
  /** Qty to subtract from `onHand` (positive; caller negates). */
  quantity: number;
}

interface ExplodeInput {
  itemId: string;
  quantity: number;
}

/**
 * Resolve each cart line to the set of stock rows that move on this sale.
 *
 * - BOM-backed finished goods (`item.bomId != null`) explode to one ledger
 *   line per component: `quantity = component.quantity * line.quantity`.
 *   The finished good itself is NOT decremented — the inventory that
 *   physically moves is the components (ARCHITECTURE ADR-003).
 * - Items without a BOM but with `isStockTracked` decrement the item row
 *   itself by `line.quantity`.
 * - Items with no BOM and `isStockTracked = false` (e.g. services, prepared
 *   items not on inventory) produce no stock movement.
 *
 * Duplicate component itemIds (same raw material across several cart lines)
 * are coalesced into a single entry so we issue one `applyOptimisticDelta`
 * per itemId — Dexie round-trips are the hot path inside the finalize tx.
 */
export async function explodeLines(
  database: Database,
  lines: readonly ExplodeInput[],
  itemById: ReadonlyMap<string, Item>,
): Promise<ExplodedStockLine[]> {
  const totals = new Map<string, number>();
  const addTo = (itemId: string, qty: number) => {
    totals.set(itemId, (totals.get(itemId) ?? 0) + qty);
  };

  for (const line of lines) {
    const item = itemById.get(line.itemId);
    if (!item) continue;

    if (item.bomId) {
      const bom = await database.repos.boms.getById(item.bomId);
      if (!bom) continue;
      for (const component of bom.components) {
        addTo(component.componentItemId, component.quantity * line.quantity);
      }
      continue;
    }

    if (item.isStockTracked) {
      addTo(item.id, line.quantity);
    }
  }

  return [...totals.entries()].map(([itemId, quantity]) => ({ itemId, quantity }));
}
