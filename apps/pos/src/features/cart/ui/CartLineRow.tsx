import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useIntl } from "react-intl";
import { formatIdr } from "../../../shared/money/index.ts";
import type { CartLine } from "../types.ts";

const SWIPE_REVEAL_PX = 96;

interface CartLineRowProps {
  line: CartLine;
  onOpenEdit(line: CartLine): void;
  onRemove(line: CartLine): void;
}

export function CartLineRow({ line, onOpenEdit, onRemove }: CartLineRowProps) {
  const intl = useIntl();
  const startX = useRef<number | null>(null);
  const [offsetPx, setOffsetPx] = useState(0);
  const revealed = offsetPx >= SWIPE_REVEAL_PX;

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    startX.current = e.clientX;
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (startX.current === null) return;
    const delta = startX.current - e.clientX;
    setOffsetPx(Math.max(0, Math.min(SWIPE_REVEAL_PX, delta)));
  }
  function onPointerUp() {
    if (startX.current === null) return;
    startX.current = null;
    if (offsetPx >= SWIPE_REVEAL_PX / 2) {
      setOffsetPx(SWIPE_REVEAL_PX);
    } else {
      setOffsetPx(0);
    }
  }

  function handleRowClick() {
    if (revealed) {
      setOffsetPx(0);
      return;
    }
    onOpenEdit(line);
  }

  function handleRemove() {
    setOffsetPx(0);
    onRemove(line);
  }

  return (
    <div
      className="relative overflow-hidden border-b border-neutral-200"
      data-testid={`cart-line-${line.itemId}`}
    >
      <button
        type="button"
        onClick={handleRemove}
        aria-label={intl.formatMessage(
          { id: "cart.row.removeAria" },
          { name: line.name },
        )}
        className="absolute inset-y-0 right-0 flex items-center justify-center bg-danger-solid px-5 text-sm font-semibold text-white"
        style={{ width: `${SWIPE_REVEAL_PX}px` }}
      >
        {intl.formatMessage({ id: "cart.row.remove" })}
      </button>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ transform: `translateX(-${offsetPx}px)` }}
        className="flex items-center justify-between bg-white px-4 py-3 transition-transform duration-[var(--animate-duration-fast)]"
      >
        <button
          type="button"
          onClick={handleRowClick}
          aria-label={intl.formatMessage(
            { id: "cart.row.editAria" },
            {
              name: line.name,
              quantity: line.quantity,
              total: formatIdr(line.lineTotalIdr),
            },
          )}
          className="flex flex-1 items-center justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 rounded-md"
        >
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-neutral-900">
              {line.name}
            </p>
            <p
              className="text-xs text-neutral-500 tabular-nums"
              data-tabular="true"
            >
              {intl.formatMessage(
                { id: "cart.row.qtyLine" },
                {
                  quantity: line.quantity,
                  unit: formatIdr(line.unitPriceIdr),
                },
              )}
            </p>
          </div>
          <p
            className="text-base font-semibold text-neutral-900 tabular-nums"
            data-tabular="true"
          >
            {formatIdr(line.lineTotalIdr)}
          </p>
        </button>
      </div>
    </div>
  );
}
