import { toRupiah, type Rupiah } from "../../shared/money/index.ts";
import type { Item, PendingSaleItem } from "../../data/db/types.ts";

/*
 * Indonesian PPN (VAT) computation — KASA-218.
 *
 * Mirrors `computeLineTaxIdr` in `apps/api/src/services/sales/service.ts`
 * verbatim so the PWA receipt preview lines up with the server-authoritative
 * number returned by `POST /v1/sales/submit`. Per-line round (then sum) is
 * the same convention; receiving devices never re-derive at the sale level.
 *
 * v0 default is `taxInclusive=true` — the Indonesian retail standard. The
 * PWA has no merchant-config pull yet (KASA-218 intentionally limits scope),
 * so the receipt preview always assumes inclusive; the server's response
 * carries the authoritative number once the sale syncs.
 */

export const DEFAULT_TAX_INCLUSIVE = true;

export function computeLineTaxIdr(
  lineTotalIdr: number,
  taxRatePercent: number,
  taxInclusive: boolean,
): number {
  // Reject non-finite rates (undefined/NaN/Infinity) up front so a single
  // catalog row that pre-dates KASA-218 cannot crash `toRupiah` downstream
  // with `Math.round(NaN)`. The wire schema defaults to 11, so this only
  // catches local-only rows (e.g. e2e seeds) and stale Dexie writes.
  if (!Number.isFinite(taxRatePercent) || taxRatePercent <= 0) return 0;
  if (lineTotalIdr <= 0) return 0;
  if (taxInclusive) {
    return Math.round(lineTotalIdr - lineTotalIdr / (1 + taxRatePercent / 100));
  }
  return Math.round((lineTotalIdr * taxRatePercent) / 100);
}

/**
 * Sum per-line tax across the cart. Lines that reference an item the catalog
 * doesn't have yet (race against sync) contribute zero rather than throwing
 * — the server will validate authoritatively on submit.
 */
export function computeSaleTaxIdr(
  lines: readonly Pick<PendingSaleItem, "itemId" | "lineTotalIdr">[],
  itemById: ReadonlyMap<string, Pick<Item, "taxRate">>,
  taxInclusive: boolean = DEFAULT_TAX_INCLUSIVE,
): Rupiah {
  let total = 0;
  for (const line of lines) {
    const item = itemById.get(line.itemId);
    if (!item) continue;
    total += computeLineTaxIdr(line.lineTotalIdr as number, item.taxRate, taxInclusive);
  }
  return toRupiah(total);
}
