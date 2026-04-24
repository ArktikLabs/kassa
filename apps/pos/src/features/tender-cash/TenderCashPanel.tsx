import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useIntl } from "react-intl";
import { NumericKeypad, applyKeypadKey } from "../../shared/components/NumericKeypad.tsx";
import {
  formatIdr,
  subtractRupiah,
  toRupiah,
  zeroRupiah,
  type Rupiah,
} from "../../shared/money/index.ts";
import { getDatabase } from "../../data/db/index.ts";
import { useCartStore } from "../cart/store.ts";
import { finalizeCashSale, SaleFinalizeError } from "../sale/finalize.ts";
import { QuickTenderChips } from "./QuickTenderChips.tsx";

const MAX_TENDER_IDR = 99_999_999;

export function TenderCashPanel() {
  const intl = useIntl();
  const navigate = useNavigate();
  const lines = useCartStore((s) => s.lines);
  const totalsFn = useCartStore((s) => s.totals);
  const clear = useCartStore((s) => s.clear);
  const t = totalsFn();
  const [tendered, setTendered] = useState<Rupiah>(zeroRupiah);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: lines.length is an intentional re-run trigger — reset stale error when cart contents change, not a captured value.
  useEffect(() => {
    setError(null);
  }, []);

  const empty = lines.length === 0;
  const changeDue: Rupiah =
    (tendered as number) >= (t.totalIdr as number)
      ? subtractRupiah(tendered, t.totalIdr)
      : zeroRupiah;
  const coverage: Rupiah =
    (tendered as number) < (t.totalIdr as number)
      ? subtractRupiah(t.totalIdr, tendered)
      : zeroRupiah;
  const covered = (tendered as number) >= (t.totalIdr as number);

  const handleKey = useCallback((key: Parameters<typeof applyKeypadKey>[1]) => {
    setTendered((current) => {
      const next = applyKeypadKey(current as number, key);
      const clamped = Math.min(Math.max(0, next), MAX_TENDER_IDR);
      return toRupiah(clamped);
    });
  }, []);

  const handleChip = useCallback((amount: Rupiah) => {
    setTendered(amount);
  }, []);

  const handleFinalize = useCallback(async () => {
    if (empty || !covered || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const database = await getDatabase();
      const result = await finalizeCashSale(
        {
          lines,
          totals: t,
          tenderedIdr: tendered,
        },
        { database },
      );
      clear();
      await navigate({
        to: "/receipt/$id",
        params: { id: result.localSaleId },
      });
    } catch (err) {
      const message =
        err instanceof SaleFinalizeError
          ? err.message
          : intl.formatMessage({ id: "tender.cash.error.unknown" });
      setError(message);
      setSubmitting(false);
    }
  }, [clear, covered, empty, intl, lines, navigate, submitting, t, tendered]);

  return (
    <section
      aria-label={intl.formatMessage({ id: "tender.cash.aria" })}
      className="flex h-full flex-col gap-4"
      data-testid="tender-cash"
    >
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-neutral-900">
          {intl.formatMessage({ id: "tender.cash.heading" })}
        </h1>
        <dl className="rounded-lg bg-white border border-neutral-200 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <dt className="text-sm text-neutral-600">
              {intl.formatMessage({ id: "tender.cash.total" })}
            </dt>
            <dd
              data-testid="tender-total"
              className="text-[32px] leading-10 font-bold tabular-nums tracking-tight text-neutral-900"
              style={{ letterSpacing: "-0.01em" }}
              data-tabular="true"
            >
              {formatIdr(t.totalIdr)}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-sm text-neutral-600">
              {intl.formatMessage({ id: "tender.cash.tendered" })}
            </dt>
            <dd
              data-testid="tender-amount"
              className="text-xl font-bold tabular-nums text-neutral-900"
              data-tabular="true"
            >
              {formatIdr(tendered)}
            </dd>
          </div>
          <div className="flex items-center justify-between border-t border-neutral-200 pt-3">
            <dt className="text-sm font-semibold text-neutral-700">
              {covered
                ? intl.formatMessage({ id: "tender.cash.change" })
                : intl.formatMessage({ id: "tender.cash.coverage" })}
            </dt>
            <dd
              data-testid={covered ? "tender-change" : "tender-coverage"}
              className={[
                "text-xl font-bold tabular-nums",
                covered ? "text-success-fg" : "text-warning-fg",
              ].join(" ")}
              data-tabular="true"
            >
              {covered ? formatIdr(changeDue) : formatIdr(coverage)}
            </dd>
          </div>
        </dl>
      </header>

      <QuickTenderChips totalIdr={t.totalIdr} onPick={handleChip} disabled={empty} />

      <NumericKeypad
        onKey={handleKey}
        disabled={empty}
        aria-label={intl.formatMessage({ id: "tender.cash.keypad.aria" })}
      />

      {error ? (
        <p
          role="alert"
          data-testid="tender-error"
          className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-fg"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-auto space-y-2">
        {empty ? (
          <p
            role="status"
            data-testid="tender-cart-empty"
            className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-fg"
          >
            {intl.formatMessage({ id: "tender.cash.cart.empty" })}
          </p>
        ) : null}
        <button
          type="button"
          disabled={empty || !covered || submitting}
          onClick={() => void handleFinalize()}
          data-testid="tender-submit"
          className={[
            "w-full h-14 rounded-md text-base font-semibold tabular-nums",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
            empty || !covered || submitting
              ? "bg-neutral-200 text-neutral-500 cursor-not-allowed"
              : "bg-primary-600 text-white active:bg-primary-700",
          ].join(" ")}
          data-tabular="true"
        >
          {submitting
            ? intl.formatMessage({ id: "tender.cash.submit.submitting" })
            : covered
              ? intl.formatMessage({ id: "tender.cash.submit.done" })
              : intl.formatMessage({ id: "tender.cash.submit.insufficient" })}
        </button>
      </div>
    </section>
  );
}
