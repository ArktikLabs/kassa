import { useCallback, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { formatIdr, toRupiah, zeroRupiah, type Rupiah } from "../../shared/money/index.ts";
import { NumericKeypad, applyKeypadKey } from "../../shared/components/NumericKeypad.tsx";
import { getDatabase } from "../../data/db/index.ts";
import type { EodClosure } from "../../data/db/types.ts";
import { apiBaseUrl } from "../../data/api/config.ts";
import { getSnapshot } from "../../lib/enrolment.ts";
import { useSyncActions } from "../../lib/sync-context.tsx";
import {
  closeEod,
  EodAlreadyClosedError,
  EodCloseError,
  EodMismatchError,
  EodVarianceReasonRequiredError,
} from "./api.ts";
import { useEodData } from "./useEodData.ts";
import { computeEodTotals } from "./totals.ts";

/*
 * `/eod` — clerk's "Tutup hari" screen. Walks the three-step dance from
 * ARCHITECTURE.md §3.1 Flow D:
 *
 *   1. show expected totals from Dexie
 *   2. collect counted cash + (if variance ≠ 0) the reason
 *   3. POST /v1/eod/close once the outbox is fully drained
 *
 * Two hard gates on the "Tutup hari" button: outbox must be empty, and if
 * the client variance is non-zero, the reason field must be filled. The
 * server repeats the check.
 */

const MAX_COUNTED_CASH = 999_999_999;

type FlowState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "mismatch"; expected: number; received: number; missingSaleIds: readonly string[] }
  | { kind: "error"; message: string };

export function EodScreen() {
  const intl = useIntl();
  const { triggerPush } = useSyncActions();
  const data = useEodData();
  const [countedCash, setCountedCash] = useState<Rupiah>(zeroRupiah);
  const [varianceReason, setVarianceReason] = useState("");
  const [flow, setFlow] = useState<FlowState>({ kind: "idle" });
  const [closure, setClosure] = useState<EodClosure | null>(null);

  const totals = useMemo(() => {
    if (!data.outlet || !data.businessDate) {
      return null;
    }
    return computeEodTotals({
      sales: data.sales,
      outletId: data.outlet.id,
      businessDate: data.businessDate,
    });
  }, [data.outlet, data.businessDate, data.sales]);

  const effectiveClosure = closure ?? data.existingClosure;
  const expectedCash = totals ? (totals.cashIdr as number) : 0;
  const variance = (countedCash as number) - expectedCash;
  const needsReason = variance !== 0;
  const outboxEmpty = data.outstandingCount === 0;
  const canSubmit =
    data.ready &&
    !effectiveClosure &&
    outboxEmpty &&
    flow.kind !== "submitting" &&
    (variance === 0 || varianceReason.trim().length > 0);

  const handleKey = useCallback((key: Parameters<typeof applyKeypadKey>[1]) => {
    setCountedCash((prev) => {
      const next = applyKeypadKey(prev as number, key);
      const clamped = Math.min(Math.max(0, next), MAX_COUNTED_CASH);
      return toRupiah(clamped);
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!data.outlet || !data.businessDate || !totals) return;
    const snap = getSnapshot();
    if (snap.state !== "enrolled") {
      setFlow({ kind: "error", message: intl.formatMessage({ id: "eod.error.unenrolled" }) });
      return;
    }
    setFlow({ kind: "submitting" });
    try {
      const response = await closeEod(
        {
          outletId: data.outlet.id,
          businessDate: data.businessDate,
          countedCashIdr: countedCash as number,
          varianceReason: varianceReason.trim().length > 0 ? varianceReason.trim() : null,
          clientSaleIds: [...totals.clientSaleIds],
        },
        {
          baseUrl: apiBaseUrl() || window.location.origin,
          auth: { apiKey: snap.device.apiKey, apiSecret: snap.device.apiSecret },
        },
      );
      const row: EodClosure = {
        key: `${response.outletId}::${response.businessDate}`,
        outletId: response.outletId,
        businessDate: response.businessDate,
        eodId: response.eodId,
        closedAt: response.closedAt,
        countedCashIdr: response.countedCashIdr,
        expectedCashIdr: response.expectedCashIdr,
        varianceIdr: response.varianceIdr,
        varianceReason: response.varianceReason,
      };
      const database = await getDatabase();
      await database.repos.eodClosures.put(row);
      setClosure(row);
      setFlow({ kind: "idle" });
    } catch (err) {
      if (err instanceof EodMismatchError) {
        setFlow({
          kind: "mismatch",
          expected: err.details.expectedCount,
          received: err.details.receivedCount,
          missingSaleIds: err.details.missingSaleIds,
        });
        return;
      }
      if (err instanceof EodAlreadyClosedError) {
        setFlow({
          kind: "error",
          message: intl.formatMessage({ id: "eod.error.already_closed" }),
        });
        return;
      }
      if (err instanceof EodVarianceReasonRequiredError) {
        setFlow({
          kind: "error",
          message: intl.formatMessage({ id: "eod.error.variance_reason_required" }),
        });
        return;
      }
      if (err instanceof EodCloseError && err.code === "network") {
        setFlow({ kind: "error", message: intl.formatMessage({ id: "eod.error.network" }) });
        return;
      }
      setFlow({ kind: "error", message: intl.formatMessage({ id: "eod.error.unknown" }) });
    }
  }, [countedCash, data.businessDate, data.outlet, intl, totals, varianceReason]);

  const handleResubmit = useCallback(async () => {
    // Reset any `needs_attention` rows that match the missing ids back to
    // queued so the drain retries them. The server's mismatch error already
    // told us which local ids it lacks.
    if (flow.kind !== "mismatch") return;
    const database = await getDatabase();
    for (const id of flow.missingSaleIds) {
      await database.repos.pendingSales.requeue(id);
    }
    setFlow({ kind: "idle" });
    await triggerPush();
  }, [flow, triggerPush]);

  if (!data.ready || !totals) {
    return (
      <section className="space-y-3" aria-busy>
        <p className="text-sm text-neutral-500">
          <FormattedMessage id="eod.loading" />
        </p>
      </section>
    );
  }

  if (effectiveClosure) {
    return <EodClosedSummary closure={effectiveClosure} />;
  }

  return (
    <section
      className="space-y-4"
      data-testid="eod-screen"
      aria-label={intl.formatMessage({ id: "eod.aria" })}
    >
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-neutral-900">
          <FormattedMessage id="eod.heading" />
        </h1>
        <p className="text-sm text-neutral-600">
          <FormattedMessage
            id="eod.subheading"
            values={{ outlet: data.outlet?.name ?? "", date: data.businessDate ?? "" }}
          />
        </p>
      </header>

      <dl
        className="rounded-lg border border-neutral-200 bg-white p-4 space-y-2 text-sm"
        data-testid="eod-totals"
      >
        <TotalsRow labelId="eod.totals.cash" value={formatIdr(totals.cashIdr)} testId="eod-cash" />
        <TotalsRow
          labelId="eod.totals.qrisUnverified"
          value={formatIdr(totals.qrisUnverifiedIdr)}
          testId="eod-qris-unverified"
        />
        <TotalsRow labelId="eod.totals.card" value={formatIdr(totals.cardIdr)} testId="eod-card" />
        <TotalsRow
          labelId="eod.totals.other"
          value={formatIdr(totals.otherIdr)}
          testId="eod-other"
        />
        <div className="flex items-center justify-between border-t border-neutral-200 pt-2">
          <dt className="font-semibold text-neutral-800">
            <FormattedMessage id="eod.totals.net" />
          </dt>
          <dd className="font-bold tabular-nums text-neutral-900" data-testid="eod-net">
            {formatIdr(totals.netIdr)}
          </dd>
        </div>
        <div className="flex items-center justify-between text-neutral-700">
          <dt>
            <FormattedMessage id="eod.totals.saleCount" />
          </dt>
          <dd data-testid="eod-sale-count">{totals.saleCount}</dd>
        </div>
      </dl>

      <section className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-base font-semibold text-neutral-900">
          <FormattedMessage id="eod.counted.heading" />
        </h2>
        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-neutral-600">
              <FormattedMessage id="eod.counted.expected" />
            </dt>
            <dd className="font-bold tabular-nums" data-testid="eod-expected-cash">
              {formatIdr(totals.cashIdr)}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-neutral-600">
              <FormattedMessage id="eod.counted.counted" />
            </dt>
            <dd className="font-bold tabular-nums" data-testid="eod-counted-cash">
              {formatIdr(countedCash)}
            </dd>
          </div>
          <div className="flex items-center justify-between border-t border-neutral-200 pt-2">
            <dt className="text-neutral-700">
              <FormattedMessage id="eod.counted.variance" />
            </dt>
            <dd
              data-testid="eod-variance"
              className={[
                "font-bold tabular-nums",
                variance < 0
                  ? "text-danger-fg"
                  : variance > 0
                    ? "text-warning-fg"
                    : "text-neutral-900",
              ].join(" ")}
            >
              {variance < 0 ? "−" : variance > 0 ? "+" : ""}
              {formatIdr(toRupiah(Math.abs(variance)))}
            </dd>
          </div>
        </dl>
        <NumericKeypad
          onKey={handleKey}
          aria-label={intl.formatMessage({ id: "eod.counted.keypadAria" })}
        />
        {needsReason ? (
          <label className="block space-y-1">
            <span className="text-sm text-neutral-700">
              <FormattedMessage id="eod.reason.label" />
            </span>
            <textarea
              rows={2}
              maxLength={500}
              value={varianceReason}
              onChange={(e) => setVarianceReason(e.target.value)}
              data-testid="eod-reason"
              placeholder={intl.formatMessage({ id: "eod.reason.placeholder" })}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm"
            />
          </label>
        ) : null}
      </section>

      {!outboxEmpty ? (
        <p
          role="status"
          data-testid="eod-outbox-status"
          className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-fg"
        >
          <FormattedMessage id="eod.outbox.waiting" values={{ count: data.outstandingCount }} />
        </p>
      ) : null}

      {flow.kind === "mismatch" ? (
        <div
          role="alert"
          data-testid="eod-mismatch"
          className="space-y-2 rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-fg"
        >
          <p>
            <FormattedMessage
              id="eod.mismatch.body"
              values={{
                missing: flow.expected - flow.received,
                expected: flow.expected,
              }}
            />
          </p>
          <button
            type="button"
            onClick={() => void handleResubmit()}
            data-testid="eod-resubmit"
            className="h-10 w-full rounded-md bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700"
          >
            <FormattedMessage id="eod.mismatch.resubmit" />
          </button>
        </div>
      ) : null}

      {flow.kind === "error" ? (
        <p
          role="alert"
          data-testid="eod-error"
          className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-fg"
        >
          {flow.message}
        </p>
      ) : null}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => void handleSubmit()}
        data-testid="eod-submit"
        className={[
          "w-full h-14 rounded-md text-base font-semibold",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
          canSubmit
            ? "bg-primary-600 text-white active:bg-primary-700"
            : "bg-neutral-200 text-neutral-500 cursor-not-allowed",
        ].join(" ")}
      >
        {flow.kind === "submitting" ? (
          <FormattedMessage id="eod.submit.submitting" />
        ) : outboxEmpty ? (
          <FormattedMessage id="eod.submit.label" />
        ) : (
          <FormattedMessage id="eod.submit.waiting" values={{ count: data.outstandingCount }} />
        )}
      </button>
    </section>
  );
}

function TotalsRow({ labelId, value, testId }: { labelId: string; value: string; testId: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-neutral-600">
        <FormattedMessage id={labelId} />
      </dt>
      <dd className="font-bold tabular-nums text-neutral-900" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function EodClosedSummary({ closure }: { closure: EodClosure }) {
  return (
    <section
      className="space-y-3 rounded-lg border border-success-border bg-success-surface p-4"
      data-testid="eod-closed"
      role="status"
    >
      <h1 className="text-lg font-bold text-success-fg">
        <FormattedMessage id="eod.closed.heading" />
      </h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-success-fg">
        <dt>
          <FormattedMessage id="eod.closed.date" />
        </dt>
        <dd data-testid="eod-closed-date">{closure.businessDate}</dd>
        <dt>
          <FormattedMessage id="eod.closed.countedCash" />
        </dt>
        <dd className="tabular-nums" data-testid="eod-closed-counted">
          {formatIdr(toRupiah(closure.countedCashIdr))}
        </dd>
        <dt>
          <FormattedMessage id="eod.closed.expectedCash" />
        </dt>
        <dd className="tabular-nums">{formatIdr(toRupiah(closure.expectedCashIdr))}</dd>
        <dt>
          <FormattedMessage id="eod.closed.variance" />
        </dt>
        <dd
          className={[
            "tabular-nums",
            closure.varianceIdr < 0
              ? "text-danger-fg"
              : closure.varianceIdr > 0
                ? "text-warning-fg"
                : "",
          ].join(" ")}
          data-testid="eod-closed-variance"
        >
          {closure.varianceIdr < 0 ? "−" : closure.varianceIdr > 0 ? "+" : ""}
          {formatIdr(toRupiah(Math.abs(closure.varianceIdr)))}
        </dd>
        {closure.varianceReason ? (
          <>
            <dt>
              <FormattedMessage id="eod.closed.reason" />
            </dt>
            <dd data-testid="eod-closed-reason">{closure.varianceReason}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
