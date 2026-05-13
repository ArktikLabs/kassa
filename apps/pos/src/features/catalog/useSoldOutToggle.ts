import { useCallback } from "react";
import { getDatabase } from "../../data/db/index.ts";
import type { Item, ItemAvailability } from "../../data/db/types.ts";

/**
 * KASA-248 — flip an item's `availability` locally and enqueue the
 * `PATCH /v1/catalog/items/:id` mutation for the outbox to drain.
 *
 * Optimistic-first: the local row is written before the network call so
 * the catalog tile greys inside the 200 ms AC. The drain in
 * `data/sync/push-catalog.ts` ships the change; the next reference-pull
 * cycle reconciles other devices via `items.availability`.
 */
export function useSoldOutToggle(): {
  setAvailability: (item: Item, next: ItemAvailability) => Promise<void>;
} {
  const setAvailability = useCallback(async (item: Item, next: ItemAvailability) => {
    const db = await getDatabase();
    // Same-state taps are still surfaced as a no-op enqueue so a flapping
    // network or a re-tap after a Sentry-reported error retriggers the
    // drain; the outbox key collapses identical states to one row anyway.
    await db.repos.items.setAvailability(item.id, next);
    await db.repos.pendingCatalogMutations.enqueue({
      itemId: item.id,
      availability: next,
      createdAt: new Date().toISOString(),
    });
  }, []);
  return { setAvailability };
}
