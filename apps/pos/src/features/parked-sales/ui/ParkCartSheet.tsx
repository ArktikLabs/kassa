import { useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { MAX_PARK_LABEL_LENGTH } from "../repository.ts";

/**
 * Bottom-sheet for capturing the clerk's label before parking the cart.
 * Closed via Cancel, ESC, or a successful Park; the parent owns the
 * Dexie write so the sheet stays purely presentational.
 */

export interface ParkCartSheetProps {
  open: boolean;
  onClose(): void;
  onSubmit(label: string): Promise<void> | void;
  initialLabel?: string;
  /** Set by the parent to surface server/store-level errors. */
  error?: string | null;
}

export function ParkCartSheet({
  open,
  onClose,
  onSubmit,
  initialLabel,
  error,
}: ParkCartSheetProps) {
  const intl = useIntl();
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [label, setLabel] = useState(initialLabel ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(initialLabel ?? "");
    setLocalError(null);
    setSubmitting(false);
    // Focus the input on next tick so the autofocus survives portal mount.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, initialLabel]);

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

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (submitting) return;
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      setLocalError(intl.formatMessage({ id: "cart.park.error.blank" }));
      return;
    }
    setSubmitting(true);
    setLocalError(null);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : intl.formatMessage({ id: "cart.park.error.unknown" }),
      );
      setSubmitting(false);
    }
  };

  const displayError = localError ?? error ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center"
      data-testid="park-cart-sheet"
    >
      <div className="w-full max-w-md rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl">
        <header className="space-y-1">
          <h2 id={titleId} className="text-lg font-bold text-neutral-900">
            <FormattedMessage id="cart.park.sheet.title" />
          </h2>
          <p id={descriptionId} className="text-sm text-neutral-600">
            <FormattedMessage id="cart.park.sheet.body" />
          </p>
        </header>
        <div className="mt-4 space-y-2">
          <label htmlFor={inputId} className="block text-sm font-medium text-neutral-700">
            <FormattedMessage id="cart.park.label.label" />
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            value={label}
            maxLength={MAX_PARK_LABEL_LENGTH}
            placeholder={intl.formatMessage({ id: "cart.park.label.placeholder" })}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            className="w-full rounded-lg border border-neutral-300 px-3 py-3 text-base text-neutral-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
            data-testid="park-cart-label-input"
            autoComplete="off"
            inputMode="text"
          />
          <p className="text-xs text-neutral-500">
            <FormattedMessage id="cart.park.label.hint" />
          </p>
          {displayError ? (
            <p
              role="alert"
              className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              data-testid="park-cart-error"
            >
              {displayError}
            </p>
          ) : null}
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            data-testid="park-cart-cancel"
            className="h-11 flex-1 rounded-md border border-neutral-300 bg-white font-semibold text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed"
          >
            <FormattedMessage id="cart.park.cancel" />
          </button>
          <button
            type="button"
            onClick={() => {
              void submit();
            }}
            disabled={submitting}
            data-testid="park-cart-confirm"
            className="h-11 flex-1 rounded-md bg-neutral-900 font-semibold text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
          >
            <FormattedMessage id="cart.park.confirm" />
          </button>
        </div>
      </div>
    </div>
  );
}
