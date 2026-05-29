import { useEffect, useId, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { formatIdr, toRupiah } from "../../../shared/money/index.ts";
import type { ParkedSale } from "../../../data/db/types.ts";

/**
 * Slide-up sheet listing parked carts for the active shift. Each row
 * exposes a "Resume" affordance and a "Discard" affordance (which the
 * parent gates behind the manager PIN). Empty state mirrors the cart
 * empty state so the affordance is discoverable but doesn't shout when
 * nothing is parked.
 */

export interface ParkedTraySheetProps {
  open: boolean;
  rows: readonly ParkedSale[];
  /** Local now for the relative timestamps; injectable for tests. */
  nowMs?: number;
  onClose(): void;
  onResume(row: ParkedSale): void;
  onDiscard(row: ParkedSale): void;
}

function lineSubtotal(row: ParkedSale): number {
  return row.lines.reduce((acc, l) => acc + (l.lineTotalIdr as number), 0);
}

function totalAfterDiscount(row: ParkedSale): number {
  const subtotal = lineSubtotal(row);
  const discount = Math.min(row.discountIdr as number, subtotal);
  return subtotal - discount;
}

function lineCount(row: ParkedSale): number {
  return row.lines.reduce((acc, l) => acc + l.quantity, 0);
}

export function ParkedTraySheet({
  open,
  rows,
  nowMs,
  onClose,
  onResume,
  onDiscard,
}: ParkedTraySheetProps) {
  const titleId = useId();
  const [now, setNow] = useState<number>(nowMs ?? Date.now());

  useEffect(() => {
    if (!open || nowMs !== undefined) return;
    setNow(Date.now());
  }, [open, nowMs]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => (b.parkedAt < a.parkedAt ? -1 : b.parkedAt > a.parkedAt ? 1 : 0)),
    [rows],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center"
      data-testid="parked-tray-sheet"
    >
      <div className="flex w-full max-w-md flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
          <h2 id={titleId} className="text-lg font-bold text-neutral-900">
            <FormattedMessage id="cart.parked.tray.title" />
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-100"
            data-testid="parked-tray-close"
          >
            <FormattedMessage id="cart.parked.tray.close" />
          </button>
        </header>
        <div className="max-h-[60vh] overflow-y-auto">
          {sortedRows.length === 0 ? (
            <p
              className="px-4 py-8 text-center text-sm text-neutral-500"
              data-testid="parked-tray-empty"
            >
              <FormattedMessage id="cart.parked.tray.empty" />
            </p>
          ) : (
            <ul className="divide-y divide-neutral-200" data-testid="parked-tray-list">
              {sortedRows.map((row) => (
                <ParkedTrayRow
                  key={row.id}
                  row={row}
                  nowMs={now}
                  onResume={() => onResume(row)}
                  onDiscard={() => onDiscard(row)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ParkedTrayRow({
  row,
  onResume,
  onDiscard,
}: {
  row: ParkedSale;
  nowMs: number;
  onResume(): void;
  onDiscard(): void;
}) {
  const intl = useIntl();
  const total = totalAfterDiscount(row);
  const items = lineCount(row);
  const parkedTime = intl.formatTime(new Date(row.parkedAt), {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <li
      className="space-y-2 px-4 py-3"
      data-testid="parked-tray-row"
      data-parked-id={row.id}
      data-parked-label={row.label}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p
          className="truncate text-base font-semibold text-neutral-900"
          data-testid="parked-tray-row-label"
        >
          {row.label}
        </p>
        <p className="text-sm tabular-nums text-neutral-700" data-testid="parked-tray-row-total">
          {formatIdr(toRupiah(total))}
        </p>
      </div>
      <p className="text-xs text-neutral-500">
        <FormattedMessage
          id="cart.parked.row.itemsLine"
          values={{ count: items, total: formatIdr(toRupiah(total)) }}
        />
      </p>
      <p className="text-xs text-neutral-500">
        <FormattedMessage id="cart.parked.row.parkedAt" values={{ time: parkedTime }} />
      </p>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onDiscard}
          aria-label={intl.formatMessage(
            { id: "cart.parked.row.discardAria" },
            { label: row.label },
          )}
          className="h-10 flex-1 rounded-md border border-red-300 bg-white text-sm font-semibold text-red-700 hover:bg-red-50"
          data-testid="parked-tray-row-discard"
        >
          <FormattedMessage id="cart.parked.row.discard" />
        </button>
        <button
          type="button"
          onClick={onResume}
          aria-label={intl.formatMessage(
            { id: "cart.parked.row.resumeAria" },
            { label: row.label },
          )}
          className="h-10 flex-1 rounded-md bg-neutral-900 text-sm font-semibold text-white hover:bg-neutral-800"
          data-testid="parked-tray-row-resume"
        >
          <FormattedMessage id="cart.parked.row.resume" />
        </button>
      </div>
    </li>
  );
}
