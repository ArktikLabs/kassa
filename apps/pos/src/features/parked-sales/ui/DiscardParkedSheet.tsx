import { useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { defaultPinVerifier, isValidPinShape } from "../../../lib/idle-lock.ts";
import type { ParkedSale } from "../../../data/db/types.ts";

/**
 * Confirmation sheet for discarding a parked cart. Manager PIN required —
 * a clerk-side discard would silently lose a customer's cart, so we gate
 * it the same way KASA-251 gates other destructive POS actions.
 */

export interface DiscardParkedSheetProps {
  row: ParkedSale | null;
  onClose(): void;
  onConfirm(row: ParkedSale): Promise<void> | void;
  /** Override the PIN verifier for tests. */
  verifyPin?: (pin: string) => "cashier" | "manager" | null;
}

export function DiscardParkedSheet({
  row,
  onClose,
  onConfirm,
  verifyPin = defaultPinVerifier,
}: DiscardParkedSheetProps) {
  const intl = useIntl();
  const titleId = useId();
  const bodyId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!row) return;
    setPin("");
    setError(null);
    setSubmitting(false);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [row]);

  useEffect(() => {
    if (!row) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [row, onClose]);

  if (!row) return null;

  const submit = async (): Promise<void> => {
    if (submitting) return;
    if (!isValidPinShape(pin) || verifyPin(pin) !== "manager") {
      setError(intl.formatMessage({ id: "cart.parked.discard.error.wrongPin" }));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(row);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : intl.formatMessage({ id: "cart.park.error.unknown" }),
      );
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      data-testid="discard-parked-sheet"
    >
      <div className="w-full max-w-md rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl">
        <header className="space-y-1">
          <h2 id={titleId} className="text-lg font-bold text-neutral-900">
            <FormattedMessage id="cart.parked.discard.title" values={{ label: row.label }} />
          </h2>
          <p id={bodyId} className="text-sm text-neutral-600">
            <FormattedMessage id="cart.parked.discard.body" />
          </p>
        </header>
        <div className="mt-4 space-y-2">
          <label htmlFor={inputId} className="block text-sm font-medium text-neutral-700">
            <FormattedMessage id="cart.parked.discard.pin.label" />
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            className="w-full rounded-lg border border-neutral-300 px-3 py-3 text-center text-2xl tracking-[0.4em] text-neutral-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
            data-testid="discard-parked-pin-input"
            autoComplete="off"
          />
          {error ? (
            <p
              role="alert"
              className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              data-testid="discard-parked-error"
            >
              {error}
            </p>
          ) : null}
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            data-testid="discard-parked-cancel"
            className="h-11 flex-1 rounded-md border border-neutral-300 bg-white font-semibold text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed"
          >
            <FormattedMessage id="cart.parked.discard.cancel" />
          </button>
          <button
            type="button"
            onClick={() => {
              void submit();
            }}
            disabled={submitting}
            data-testid="discard-parked-confirm"
            className="h-11 flex-1 rounded-md bg-red-700 font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:bg-red-300"
          >
            <FormattedMessage id="cart.parked.discard.confirm" />
          </button>
        </div>
      </div>
    </div>
  );
}
