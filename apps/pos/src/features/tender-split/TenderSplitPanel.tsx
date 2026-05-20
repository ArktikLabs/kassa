import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FormattedMessage, useIntl } from "react-intl";
import {
  createQrisOrder,
  QrisApiError,
  type CreateQrisOrderResponse,
  type QrisOrderStatusName,
} from "../../data/api/qris";
import { getDatabase } from "../../data/db/index.ts";
import type { PendingSaleTender } from "../../data/db/types.ts";
import { uuidv7 } from "../../lib/uuidv7.ts";
import { NumericKeypad, applyKeypadKey } from "../../shared/components/NumericKeypad.tsx";
import {
  formatIdr,
  subtractRupiah,
  toRupiah,
  zeroRupiah,
  type Rupiah,
} from "../../shared/money/index.ts";
import { QrSvg } from "../tender-qris/QrSvg.tsx";
import { useQrisPoll } from "../tender-qris/useQrisPoll.ts";
import { useSyncStatus } from "../../lib/sync-context.tsx";
import { useCartStore } from "../cart/store.ts";
import { finalizeSplitSale, SaleFinalizeError } from "../sale/finalize.ts";

/*
 * KASA-310 — split tender (cash + QRIS) in a single sale.
 *
 * One screen runs the whole split flow:
 *  1. Clerk enters the cash leg (chips + keypad). QRIS leg auto-fills as
 *     `total − cash` and disables once we hit zero (degenerate split).
 *  2. Mode toggle picks dynamic-QRIS (Buat QR + poll) or static-QRIS
 *     (printed QR + buyerRefLast4 capture). The auto detector mirrors
 *     `/tender/qris` — offline tablets default to static.
 *  3. On confirm, `finalizeSplitSale` writes ONE pending_sale row with
 *     both tenders inside a single Dexie rw-tx so a sync mid-write cannot
 *     land just one leg.
 *
 * The cash leg's amountIdr is the portion *applied*, not the over-tendered
 * count — split-tender doesn't accept change. (Pure cash with change is
 * still /tender/cash.)
 */

type QrisMode = "dynamic" | "static";

type DynamicStep =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "waiting"; order: CreatedOrder }
  | { kind: "finalizing"; order: CreatedOrder }
  | { kind: "error"; error: QrisApiError };

interface CreatedOrder extends CreateQrisOrderResponse {
  localSaleId: string;
}

type IsOffline = () => boolean;

const defaultIsOffline: IsOffline = () =>
  typeof navigator !== "undefined" && navigator.onLine === false;

const MAX_CASH_IDR = 99_999_999;

export interface TenderSplitPanelProps {
  /** Test seam: stub `navigator.onLine`. */
  isOffline?: IsOffline;
  /** Test seam: force a specific QRIS mode (skip auto-detection). */
  initialMode?: QrisMode | "auto";
  /** Test seam: stable id generator. */
  generateLocalSaleId?: () => string;
}

export function TenderSplitPanel({
  isOffline = defaultIsOffline,
  initialMode = "auto",
  generateLocalSaleId,
}: TenderSplitPanelProps = {}) {
  const intl = useIntl();
  const navigate = useNavigate();
  const sync = useSyncStatus();
  const lines = useCartStore((s) => s.lines);
  const totalsFn = useCartStore((s) => s.totals);
  const clear = useCartStore((s) => s.clear);
  const t = totalsFn();

  const [cashIdr, setCashIdr] = useState<Rupiah>(zeroRupiah);
  const [last4, setLast4] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // QRIS mode follows /tender/qris semantics: auto = static when offline,
  // dynamic otherwise. The clerk can pin a mode for the rest of the screen
  // via the toggle.
  const [override, setOverride] = useState<"auto" | QrisMode>(initialMode);
  const detected: QrisMode = isOffline() || sync.phase.kind === "offline" ? "static" : "dynamic";
  const mode: QrisMode = override === "auto" ? detected : override;

  // Dynamic-QRIS orchestration (only used in dynamic mode).
  const [dynamic, setDynamic] = useState<DynamicStep>({ kind: "idle" });
  const creatingRef = useRef(false);
  const finalizedOrderRef = useRef<string | null>(null);
  const pollOrderId = dynamic.kind === "waiting" ? dynamic.order.qrisOrderId : null;
  const poll = useQrisPoll(pollOrderId);
  const pollStatus: QrisOrderStatusName | null = poll.status;

  const empty = lines.length === 0;
  const total = t.totalIdr as number;
  const cash = cashIdr as number;
  const cashOver = cash > total;
  const qrisIdr: Rupiah = cash >= total ? zeroRupiah : subtractRupiah(t.totalIdr, cashIdr);
  // Both legs must be present for a true *split*. Use single-method routes
  // (cash → /tender/cash, qris → /tender/qris) when one leg is zero.
  const validSplit = !empty && cash > 0 && cash < total;

  const handleKey = useCallback((key: Parameters<typeof applyKeypadKey>[1]) => {
    setCashIdr((current) => {
      const next = applyKeypadKey(current as number, key);
      const clamped = Math.min(Math.max(0, next), MAX_CASH_IDR);
      return toRupiah(clamped);
    });
    setErrorMessage(null);
  }, []);

  const handleChip = useCallback(
    (amount: Rupiah) => {
      // Cap chip amounts at total − 1 (so QRIS leg has something to do).
      const clamped = Math.min(amount as number, Math.max(0, total - 1));
      setCashIdr(toRupiah(clamped));
      setErrorMessage(null);
    },
    [total],
  );

  const handleLast4Change = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const digitsOnly = e.target.value.replace(/\D/g, "").slice(0, 4);
    setLast4(digitsOnly);
    setErrorMessage(null);
  }, []);

  const finalize = useCallback(
    async (tenders: readonly PendingSaleTender[], localSaleId?: string) => {
      setSubmitting(true);
      setErrorMessage(null);
      try {
        const database = await getDatabase();
        const result = await finalizeSplitSale(
          {
            lines,
            totals: t,
            tenders,
            ...(localSaleId !== undefined ? { localSaleId } : {}),
          },
          {
            database,
            ...(generateLocalSaleId ? { generateLocalSaleId } : {}),
          },
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
            : intl.formatMessage({ id: "tender.split.error.finalize" });
        setErrorMessage(message);
        setSubmitting(false);
      }
    },
    [clear, generateLocalSaleId, intl, lines, navigate, t],
  );

  // Static-mode finalise: cash + qris_static in one go. No Midtrans round
  // trip — the buyerRefLast4 carries the reconciliation key.
  const last4Valid = /^\d{4}$/.test(last4);
  const canSubmitStatic = validSplit && last4Valid && !submitting;
  const handleSubmitStatic = useCallback(() => {
    if (!canSubmitStatic) return;
    const tenders: PendingSaleTender[] = [
      { method: "cash", amountIdr: cashIdr, reference: null },
      {
        method: "qris_static",
        amountIdr: qrisIdr,
        reference: null,
        verified: false,
        buyerRefLast4: last4,
      },
    ];
    void finalize(tenders);
  }, [canSubmitStatic, cashIdr, finalize, last4, qrisIdr]);

  // Dynamic-mode QR mint: localSaleId doubles as Midtrans order_id (same
  // 1:1 reconciliation contract as /tender/qris).
  const handleCreateQr = useCallback(async () => {
    if (!validSplit || creatingRef.current) return;
    if (dynamic.kind !== "idle" && dynamic.kind !== "error") return;
    creatingRef.current = true;
    setDynamic({ kind: "creating" });
    setErrorMessage(null);
    const localSaleId = generateLocalSaleId ? generateLocalSaleId() : uuidv7();
    try {
      const database = await getDatabase();
      const deviceSecret = await database.repos.deviceSecret.get();
      if (!deviceSecret) {
        throw new QrisApiError("bad_request", "device is not enrolled");
      }
      const response = await createQrisOrder({
        amount: qrisIdr as number,
        localSaleId,
        outletId: deviceSecret.outletId,
      });
      setDynamic({ kind: "waiting", order: { ...response, localSaleId } });
    } catch (err) {
      const e = err instanceof QrisApiError ? err : new QrisApiError("unknown", String(err));
      setDynamic({ kind: "error", error: e });
    } finally {
      creatingRef.current = false;
    }
  }, [dynamic.kind, generateLocalSaleId, qrisIdr, validSplit]);

  const handleResetDynamic = useCallback(() => {
    finalizedOrderRef.current = null;
    creatingRef.current = false;
    setDynamic({ kind: "idle" });
    setErrorMessage(null);
  }, []);

  // Drive finalize once the buyer pays. Guard against late polling ticks
  // (capture → settlement) by tracking the finalised order id.
  useEffect(() => {
    if (dynamic.kind !== "waiting") return;
    if (pollStatus !== "paid" || poll.grossAmount === null) return;
    const order = dynamic.order;
    if (finalizedOrderRef.current === order.qrisOrderId) return;
    // Refuse to enqueue if the upstream amount doesn't match the QRIS
    // portion we minted the QR for — defence-in-depth against tampered
    // status responses or a cart mutation between create and paid.
    if (poll.grossAmount !== (qrisIdr as number)) {
      setErrorMessage(intl.formatMessage({ id: "tender.split.error.amount_mismatch" }));
      return;
    }
    finalizedOrderRef.current = order.qrisOrderId;
    setDynamic({ kind: "finalizing", order });
    const tenders: PendingSaleTender[] = [
      { method: "cash", amountIdr: cashIdr, reference: null },
      { method: "qris", amountIdr: qrisIdr, reference: order.qrisOrderId },
    ];
    void finalize(tenders, order.localSaleId);
  }, [cashIdr, dynamic, finalize, intl, poll.grossAmount, pollStatus, qrisIdr]);

  const dynamicStatusLabel = useMemo(() => {
    if (dynamic.kind === "finalizing") {
      return intl.formatMessage({ id: "tender.qris.status.paid" });
    }
    if (pollStatus === "paid") return intl.formatMessage({ id: "tender.qris.status.paid" });
    if (pollStatus === "expired") return intl.formatMessage({ id: "tender.qris.status.expired" });
    if (pollStatus === "cancelled")
      return intl.formatMessage({ id: "tender.qris.status.cancelled" });
    if (pollStatus === "failed") return intl.formatMessage({ id: "tender.qris.status.failed" });
    return intl.formatMessage({ id: "tender.qris.status.polling" });
  }, [dynamic.kind, intl, pollStatus]);

  return (
    <section
      aria-label={intl.formatMessage({ id: "tender.split.aria" })}
      className="flex h-full flex-col gap-4"
      data-testid="tender-split"
      data-mode={mode}
      data-mode-source={override === "auto" ? "auto" : "manual"}
    >
      <header className="space-y-2">
        <h1 className="text-lg font-bold text-neutral-900">
          <FormattedMessage id="tender.split.heading" />
        </h1>
        <dl className="rounded-lg border border-neutral-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <dt className="text-sm text-neutral-600">
              <FormattedMessage id="tender.split.total" />
            </dt>
            <dd
              data-testid="tender-split-total"
              className="text-[32px] leading-10 font-bold tabular-nums tracking-tight text-neutral-900"
              style={{ letterSpacing: "-0.01em" }}
              data-tabular="true"
            >
              {formatIdr(t.totalIdr)}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-sm text-neutral-600">
              <FormattedMessage id="tender.split.cash" />
            </dt>
            <dd
              data-testid="tender-split-cash"
              className="text-xl font-bold tabular-nums text-neutral-900"
              data-tabular="true"
            >
              {formatIdr(cashIdr)}
            </dd>
          </div>
          <div className="flex items-center justify-between border-t border-neutral-200 pt-3">
            <dt className="text-sm font-semibold text-neutral-700">
              <FormattedMessage id="tender.split.qris" />
            </dt>
            <dd
              data-testid="tender-split-qris"
              className="text-xl font-bold tabular-nums text-primary-700"
              data-tabular="true"
            >
              {formatIdr(qrisIdr)}
            </dd>
          </div>
        </dl>
      </header>

      {empty ? (
        <p
          role="status"
          data-testid="tender-split-cart-empty"
          className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-fg"
        >
          <FormattedMessage id="tender.split.cart.empty" />
        </p>
      ) : null}

      {cashOver ? (
        <p
          role="alert"
          data-testid="tender-split-cash-over"
          className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-fg"
        >
          <FormattedMessage id="tender.split.cash.over" />
        </p>
      ) : null}

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-600">
          <FormattedMessage id="tender.split.cash.label" />
        </p>
        <SplitChips totalIdr={t.totalIdr} onPick={handleChip} disabled={empty} />
        <NumericKeypad
          onKey={handleKey}
          disabled={empty}
          aria-label={intl.formatMessage({ id: "tender.split.keypad.aria" })}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-neutral-600">
          {mode === "static" ? (
            <FormattedMessage id="tender.qris.mode.static.label" />
          ) : (
            <FormattedMessage id="tender.qris.mode.dynamic.label" />
          )}
        </span>
        <button
          type="button"
          onClick={() => setOverride(mode === "static" ? "dynamic" : "static")}
          data-testid="tender-split-mode-toggle"
          aria-label={intl.formatMessage({ id: "tender.qris.mode.toggle.aria" })}
          className="rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs font-semibold text-neutral-800 active:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
        >
          {mode === "static" ? (
            <FormattedMessage id="tender.qris.mode.toggle.dynamic" />
          ) : (
            <FormattedMessage id="tender.qris.mode.toggle.static" />
          )}
        </button>
      </div>

      {mode === "static" ? (
        <div className="space-y-2" data-testid="tender-split-static">
          <label
            htmlFor="tender-split-last4"
            className="block text-sm font-semibold text-neutral-700"
          >
            <FormattedMessage id="tender.qris.static.last4.label" />
          </label>
          <input
            id="tender-split-last4"
            data-testid="tender-split-last4"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            pattern="\d{4}"
            value={last4}
            onChange={handleLast4Change}
            aria-invalid={last4.length > 0 && !last4Valid}
            className="block h-14 w-full rounded-md border border-neutral-300 bg-white px-3 text-center text-2xl font-bold tabular-nums tracking-[0.4em] text-neutral-900 focus-visible:border-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
            disabled={!validSplit}
          />
          <p className="text-xs text-neutral-600">
            <FormattedMessage id="tender.qris.static.last4.hint" />
          </p>
        </div>
      ) : null}

      {mode === "dynamic" && dynamic.kind === "waiting" ? (
        <div
          data-testid="tender-split-dynamic-display"
          data-qris-order-id={dynamic.order.qrisOrderId}
          className="flex flex-col items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3"
        >
          <p className="text-center text-sm font-semibold text-neutral-700">
            <FormattedMessage
              id="tender.qris.instructions"
              values={{ total: formatIdr(qrisIdr) }}
            />
          </p>
          <QrSvg value={dynamic.order.qrString} size={224} testId="tender-split-qr" />
          <p
            role="status"
            data-testid="tender-split-dynamic-status"
            data-status={pollStatus ?? "polling"}
            className="text-sm tabular-nums text-neutral-600"
          >
            {dynamicStatusLabel}
          </p>
          {pollStatus === "expired" || pollStatus === "cancelled" || pollStatus === "failed" ? (
            <button
              type="button"
              onClick={handleResetDynamic}
              data-testid="tender-split-dynamic-retry"
              className="h-11 rounded-md bg-primary-600 px-4 text-sm font-semibold text-white active:bg-primary-700"
            >
              <FormattedMessage id="tender.qris.retry" />
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === "dynamic" && dynamic.kind === "error" ? (
        <p
          role="alert"
          data-testid="tender-split-dynamic-error"
          data-error-code={dynamic.error.code}
          className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-fg"
        >
          {dynamic.error.code === "network_error" ? (
            <FormattedMessage id="tender.qris.error.offline" />
          ) : dynamic.error.code === "payments_unavailable" ? (
            <FormattedMessage id="tender.qris.error.unavailable" />
          ) : (
            <FormattedMessage id="tender.qris.error.create" />
          )}
        </p>
      ) : null}

      {errorMessage ? (
        <p
          role="alert"
          data-testid="tender-split-error"
          className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-fg"
        >
          {errorMessage}
        </p>
      ) : null}

      <div className="mt-auto space-y-2">
        {mode === "static" ? (
          <button
            type="button"
            disabled={!canSubmitStatic}
            onClick={handleSubmitStatic}
            data-testid="tender-split-submit-static"
            className={[
              "w-full h-14 rounded-md text-base font-semibold tabular-nums",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
              !canSubmitStatic
                ? "bg-neutral-200 text-neutral-500 cursor-not-allowed"
                : "bg-primary-600 text-white active:bg-primary-700",
            ].join(" ")}
          >
            {submitting ? (
              <FormattedMessage id="tender.split.submit.submitting" />
            ) : (
              <FormattedMessage id="tender.split.submit.done" />
            )}
          </button>
        ) : (
          <button
            type="button"
            disabled={!validSplit || dynamic.kind === "creating" || dynamic.kind === "waiting"}
            onClick={() => void handleCreateQr()}
            data-testid="tender-split-submit-dynamic"
            className={[
              "w-full h-14 rounded-md text-base font-semibold tabular-nums",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
              !validSplit || dynamic.kind === "creating" || dynamic.kind === "waiting"
                ? "bg-neutral-200 text-neutral-500 cursor-not-allowed"
                : "bg-primary-600 text-white active:bg-primary-700",
            ].join(" ")}
          >
            {dynamic.kind === "creating" ? (
              <FormattedMessage id="tender.qris.create.loading" />
            ) : (
              <FormattedMessage id="tender.split.create.cta" />
            )}
          </button>
        )}
        <button
          type="button"
          disabled={submitting}
          onClick={() => {
            if (submitting) return;
            void navigate({ to: "/tender/cash" });
          }}
          data-testid="tender-split-switch-cash"
          className="h-12 w-full rounded-md border border-neutral-300 text-base font-semibold text-neutral-800 active:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <FormattedMessage id="tender.split.switch.cash" />
        </button>
      </div>
    </section>
  );
}

interface SplitChipsProps {
  totalIdr: Rupiah;
  onPick(amount: Rupiah): void;
  disabled?: boolean;
}

// Split-tender's chips are anchored to fractions of the bill rather than
// fixed denominations: the clerk usually wants "half on cash, the rest on
// QRIS". `Setengah` picks 50% rounded to the nearest 1k so the QRIS leg
// stays a clean number.
function SplitChips({ totalIdr, onPick, disabled }: SplitChipsProps) {
  const intl = useIntl();
  const total = totalIdr as number;
  const half = Math.round(total / 2 / 1_000) * 1_000;
  const chips: Array<{ key: string; label: string; amount: number }> = [
    { key: "setengah", label: intl.formatMessage({ id: "tender.split.chip.half" }), amount: half },
    { key: "10k", label: formatIdr(toRupiah(10_000)), amount: 10_000 },
    { key: "20k", label: formatIdr(toRupiah(20_000)), amount: 20_000 },
    { key: "50k", label: formatIdr(toRupiah(50_000)), amount: 50_000 },
  ];
  return (
    <div
      role="group"
      aria-label={intl.formatMessage({ id: "tender.split.chips.aria" })}
      className="flex flex-wrap gap-2"
      data-testid="tender-split-chips"
    >
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          disabled={disabled}
          onClick={() => onPick(toRupiah(chip.amount))}
          data-testid={`tender-split-chip-${chip.key}`}
          className="h-11 rounded-full border border-neutral-300 bg-white px-4 text-sm font-semibold tabular-nums text-neutral-800 active:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
          data-tabular="true"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
