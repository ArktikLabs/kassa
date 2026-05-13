import { useRef } from "react";
import { useIntl } from "react-intl";
import { formatIdr } from "../../shared/money/index.ts";
import type { Item } from "../../data/db/types.ts";

const LONG_PRESS_MS = 500;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  const second = parts[1];
  if (!first) return "··";
  if (!second) return first.slice(0, 2).toUpperCase().padEnd(2, "·");
  return `${first[0] ?? ""}${second[0] ?? ""}`.toUpperCase();
}

export interface CatalogTileProps {
  item: Item;
  outOfStock: boolean;
  /**
   * KASA-248 — set when the tile is greyed because of the manual
   * `availability='sold_out'` flag (as opposed to inventory). Manual
   * sold-outs still accept long-press so the cashier can flip the
   * tile back to `available` from the catalog screen.
   */
  markedSoldOut?: boolean;
  onAdd(item: Item): void;
  onLongPress?(item: Item): void;
}

export function CatalogTile({
  item,
  outOfStock,
  markedSoldOut,
  onAdd,
  onLongPress,
}: CatalogTileProps) {
  const intl = useIntl();
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);

  function clearTimer() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function handlePointerDown() {
    // Manual sold-out (`markedSoldOut`) keeps long-press alive so the cashier
    // can re-enable the tile; inventory-driven `outOfStock` does not — there
    // is nothing for the long-press to do until stock comes back.
    if (outOfStock && !markedSoldOut) return;
    longPressed.current = false;
    clearTimer();
    longPressTimer.current = setTimeout(() => {
      longPressed.current = true;
      onLongPress?.(item);
    }, LONG_PRESS_MS);
  }

  function handlePointerUp() {
    clearTimer();
  }

  function handleClick() {
    if (outOfStock) return;
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    onAdd(item);
  }

  const ariaLabel = intl.formatMessage(
    {
      id: outOfStock ? "catalog.tile.ariaOutOfStock" : "catalog.tile.aria",
    },
    { name: item.name, price: formatIdr(item.priceIdr) },
  );

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-disabled={outOfStock || undefined}
      data-testid={`catalog-tile-${item.id}`}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClick={handleClick}
      className={[
        "group relative flex aspect-[1/1.1] min-h-[120px] flex-col justify-between",
        "rounded-xl border bg-white p-3 text-left",
        "border-neutral-200",
        "transition-colors duration-[var(--animate-duration-fast)]",
        outOfStock ? "cursor-not-allowed" : "active:border-primary-600 active:bg-primary-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        <div
          aria-hidden
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-700 font-bold tabular-nums"
        >
          {initials(item.name)}
        </div>
      </div>
      <div className="mt-2 min-w-0 space-y-1">
        <p title={item.name} className="line-clamp-2 text-sm font-semibold text-neutral-800">
          {item.name}
        </p>
        <p
          className="text-right text-sm font-semibold text-neutral-900 tabular-nums"
          data-tabular="true"
        >
          {formatIdr(item.priceIdr)}
        </p>
      </div>
      {outOfStock ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-white/60">
          <span
            className="rounded-full border border-danger-border bg-danger-surface px-2.5 py-1 text-xs font-semibold text-danger-fg"
            data-testid={`catalog-tile-${item.id}-habis`}
          >
            {intl.formatMessage({ id: "catalog.tile.outOfStock" })}
          </span>
        </div>
      ) : null}
    </button>
  );
}
