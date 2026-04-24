import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { BottomSheet } from "../../../shared/components/BottomSheet.tsx";
import { NumericKeypad, applyKeypadKey } from "../../../shared/components/NumericKeypad.tsx";
import { formatIdr, multiplyRupiah } from "../../../shared/money/index.ts";
import type { CartLine } from "../types.ts";

const MAX_QUANTITY = 9999;

interface CartEditSheetProps {
  line: CartLine | null;
  onClose(): void;
  onApply(quantity: number): void;
  onRemove(): void;
}

export function CartEditSheet({ line, onClose, onApply, onRemove }: CartEditSheetProps) {
  const intl = useIntl();
  const [draft, setDraft] = useState(0);

  useEffect(() => {
    setDraft(line?.quantity ?? 0);
  }, [line?.quantity]);

  if (!line) return null;

  function handleKey(key: Parameters<typeof applyKeypadKey>[1]) {
    setDraft((current) => {
      const next = applyKeypadKey(current, key);
      return Math.min(Math.max(0, next), MAX_QUANTITY);
    });
  }

  const draftTotal = multiplyRupiah(line.unitPriceIdr, draft);

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={intl.formatMessage({ id: "cart.edit.title" }, { name: line.name })}
      labelledById="cart-edit-title"
    >
      <div className="space-y-4">
        <div
          data-testid="cart-edit-preview"
          className="rounded-lg bg-neutral-50 p-3 text-right tabular-nums"
          data-tabular="true"
        >
          <p className="text-xs uppercase tracking-wide text-neutral-500">
            {intl.formatMessage({ id: "cart.edit.quantity" })}
          </p>
          <p className="text-3xl font-bold text-neutral-900 tabular-nums">{draft}</p>
          <p className="text-sm text-neutral-600 tabular-nums">
            {intl.formatMessage({ id: "cart.edit.preview" }, { total: formatIdr(draftTotal) })}
          </p>
        </div>
        <NumericKeypad
          onKey={handleKey}
          aria-label={intl.formatMessage({ id: "cart.edit.keypadAria" })}
        />
        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            onClick={onRemove}
            className="h-12 rounded-md border border-danger-border bg-white px-4 text-sm font-semibold text-danger-fg active:bg-danger-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-solid"
          >
            {intl.formatMessage({ id: "cart.edit.remove" })}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="h-12 rounded-md border border-neutral-300 bg-white px-4 text-sm font-semibold text-neutral-800 active:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
          >
            {intl.formatMessage({ id: "cart.edit.cancel" })}
          </button>
          <button
            type="button"
            onClick={() => onApply(draft)}
            disabled={draft === line.quantity}
            className="h-12 rounded-md bg-primary-600 px-5 text-sm font-semibold text-white active:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:bg-neutral-200 disabled:text-neutral-500"
          >
            {intl.formatMessage({ id: "cart.edit.apply" })}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
