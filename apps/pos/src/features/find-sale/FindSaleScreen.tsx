/*
 * KASA-369 — find a past sale by receipt code at the counter.
 *
 * Real-warung context: a customer returns 20-40 minutes after their
 * purchase asking to void or reprint. The post-sale `/receipt/$id`
 * screen is long gone, and `/sales/history` requires the clerk to scroll
 * the recent-sales list. This screen accepts the six-char receipt code
 * printed on the customer's slip and routes the clerk straight to the
 * existing reprint (`/sales/$id`) / manager-PIN-void (`/sale/$id/void`)
 * flows.
 *
 * Lookup is Dexie-first: every sale the device has touched (including
 * `synced` rows we keep for reprints) lives in `pending_sales`, scoped
 * by outletId so a multi-outlet device can never cross tenants. We do
 * not call the server in v0 — a fresh tablet with no outbox history
 * cannot resolve a code printed by a different device yet; the issue's
 * AC list only requires the same-device flow and we surface a clear
 * "not found" panel for the cross-device case (clerk falls back to the
 * back office reconciliation flow, which the panel links to).
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { FormattedDate, FormattedMessage, FormattedTime, useIntl } from "react-intl";
import { formatIdr } from "../../shared/money/index.ts";
import { getDatabase, type Database } from "../../data/db/index.ts";
import type { PendingSale, ShiftState } from "../../data/db/types.ts";
import {
  getSnapshot,
  hydrateEnrolment,
  subscribe,
  type EnrolmentSnapshot,
} from "../../lib/enrolment";
import { canVoidSale, computeEligibility } from "../sale/SaleVoidScreen.tsx";
import { normalizeReceiptCode, receiptCodeFor, RECEIPT_CODE_LENGTH } from "./receiptCode.ts";

/**
 * Search lifecycle. `idle` is the empty form; `searching` covers the
 * Dexie round-trip (UI shows a busy hint); `found` renders the summary
 * card; `not_found` shows the id-ID dead-end with a retry affordance.
 */
export type FindSaleState =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "found"; sale: PendingSale; shift: ShiftState | null }
  | { kind: "not_found"; code: string };

/**
 * Pure transition for tests — the screen's `onSubmit` dispatches via
 * this so the state machine can be exercised without rendering. The
 * function is total over events: every prior state accepts every event,
 * so we don't branch on `_prev`.
 */
export function reduceFindSale(
  _prev: FindSaleState,
  event:
    | { type: "submit" }
    | { type: "found"; sale: PendingSale; shift: ShiftState | null }
    | { type: "not_found"; code: string }
    | { type: "reset" },
): FindSaleState {
  switch (event.type) {
    case "submit":
      return { kind: "searching" };
    case "found":
      return { kind: "found", sale: event.sale, shift: event.shift };
    case "not_found":
      return { kind: "not_found", code: event.code };
    case "reset":
      return { kind: "idle" };
  }
}

export function FindSaleScreen() {
  const intl = useIntl();
  const navigate = useNavigate();

  const [snapshot, setSnapshot] = useState<EnrolmentSnapshot>(
    () => getSnapshot() ?? { state: "loading" },
  );
  const [db, setDb] = useState<Database | null>(null);
  const [input, setInput] = useState("");
  const [state, setState] = useState<FindSaleState>({ kind: "idle" });
  const [formatError, setFormatError] = useState<string | null>(null);

  useEffect(() => {
    void hydrateEnrolment();
    return subscribe(setSnapshot);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    getDatabase()
      .then((next) => {
        if (!cancelled) setDb(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const outletId = snapshot.state === "enrolled" ? snapshot.device.outlet.id : null;

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!db || !outletId) return;
      const code = normalizeReceiptCode(input);
      if (!code) {
        setFormatError(intl.formatMessage({ id: "findSale.error.format" }));
        return;
      }
      setFormatError(null);
      setState({ kind: "searching" });
      const sale = await db.repos.pendingSales.findByReceiptCode(outletId, code);
      if (!sale) {
        setState({ kind: "not_found", code });
        return;
      }
      const shiftRow = await db.repos.shiftState.get();
      const shift = shiftRow && shiftRow.closedAt === null ? shiftRow : null;
      setState({ kind: "found", sale, shift });
    },
    [db, input, intl, outletId],
  );

  const handleReset = useCallback(() => {
    setInput("");
    setFormatError(null);
    setState({ kind: "idle" });
  }, []);

  if (snapshot.state === "loading") {
    return (
      <section className="space-y-3" aria-busy data-testid="find-sale-loading">
        <p className="text-sm text-neutral-500">
          <FormattedMessage id="findSale.loading" />
        </p>
      </section>
    );
  }

  if (snapshot.state !== "enrolled") {
    return (
      <section
        className="space-y-2 rounded-md border border-warning-border bg-warning-surface p-4"
        role="alert"
        data-testid="find-sale-unenrolled"
      >
        <p className="text-sm text-warning-fg">
          <FormattedMessage id="findSale.unenrolled" />
        </p>
      </section>
    );
  }

  return (
    <section
      className="mx-auto max-w-xl space-y-4"
      aria-label={intl.formatMessage({ id: "findSale.aria" })}
      data-testid="find-sale-screen"
    >
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="findSale.heading" />
        </h1>
        <p className="text-sm text-neutral-600">
          <FormattedMessage id="findSale.intro" />
        </p>
      </header>

      <form
        className="space-y-3 rounded-md border border-neutral-200 bg-white p-4"
        data-testid="find-sale-form"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-neutral-900">
            <FormattedMessage id="findSale.field.code" />
          </span>
          <input
            type="text"
            value={input}
            onChange={(event) => {
              setInput(event.currentTarget.value);
              if (formatError) setFormatError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            maxLength={32}
            data-testid="find-sale-input"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base font-mono uppercase tracking-[0.3em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
            placeholder={intl.formatMessage({ id: "findSale.field.code.placeholder" })}
            aria-describedby="find-sale-code-hint"
          />
          <span id="find-sale-code-hint" className="text-xs text-neutral-600">
            <FormattedMessage
              id="findSale.field.code.hint"
              values={{ length: RECEIPT_CODE_LENGTH }}
            />
          </span>
        </label>

        {formatError ? (
          <p
            role="alert"
            data-testid="find-sale-format-error"
            className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-fg"
          >
            {formatError}
          </p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={state.kind === "searching" || input.length === 0}
            data-testid="find-sale-submit"
            className={[
              "h-12 flex-1 rounded-md text-base font-semibold",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
              state.kind === "searching" || input.length === 0
                ? "bg-neutral-200 text-neutral-500"
                : "bg-primary-600 text-white active:bg-primary-700",
            ].join(" ")}
          >
            {state.kind === "searching" ? (
              <FormattedMessage id="findSale.cta.searching" />
            ) : (
              <FormattedMessage id="findSale.cta" />
            )}
          </button>
          {state.kind !== "idle" ? (
            <button
              type="button"
              onClick={handleReset}
              data-testid="find-sale-reset"
              className="h-12 rounded-md border border-neutral-300 bg-white px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-100"
            >
              <FormattedMessage id="findSale.cta.reset" />
            </button>
          ) : null}
        </div>
      </form>

      {state.kind === "not_found" ? (
        <section
          className="space-y-2 rounded-md border border-warning-border bg-warning-surface p-4"
          role="alert"
          data-testid="find-sale-not-found"
        >
          <h2 className="text-base font-semibold text-warning-fg">
            <FormattedMessage id="findSale.notFound.heading" />
          </h2>
          <p className="text-sm text-warning-fg">
            <FormattedMessage id="findSale.notFound.body" values={{ code: state.code }} />
          </p>
        </section>
      ) : null}

      {state.kind === "found" ? (
        <SaleSummaryCard
          sale={state.sale}
          shift={state.shift}
          onVoidClick={() => {
            void navigate({ to: "/sale/$id/void", params: { id: state.sale.localSaleId } });
          }}
          onReprintClick={() => {
            void navigate({ to: "/sales/$id", params: { id: state.sale.localSaleId } });
          }}
        />
      ) : null}
    </section>
  );
}

interface SaleSummaryCardProps {
  sale: PendingSale;
  shift: ShiftState | null;
  onVoidClick: () => void;
  onReprintClick: () => void;
}

function SaleSummaryCard({ sale, shift, onVoidClick, onReprintClick }: SaleSummaryCardProps) {
  const intl = useIntl();
  const voided = sale.voidedAt != null;
  const eligibility = computeEligibility(sale, shift);
  const voidAllowed = canVoidSale(sale, shift);
  const code = receiptCodeFor(sale.localSaleId);

  return (
    <section
      className="space-y-3 rounded-md border border-neutral-200 bg-white p-4"
      data-testid="find-sale-summary"
      data-local-sale-id={sale.localSaleId}
      data-voided={voided ? "true" : undefined}
    >
      <header className="flex items-baseline justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-xs uppercase tracking-wide text-neutral-500">
            <FormattedMessage id="findSale.summary.code" />
          </p>
          <p
            data-testid="find-sale-summary-code"
            className="font-mono text-lg font-bold tracking-[0.4em] text-neutral-900"
          >
            {code}
          </p>
        </div>
        {voided ? (
          <span
            data-testid="find-sale-summary-voided"
            className="inline-flex rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-800"
          >
            <FormattedMessage id="findSale.summary.status.voided" />
          </span>
        ) : (
          <span
            data-testid="find-sale-summary-confirmed"
            className="inline-flex rounded-full border border-success-border bg-success-surface px-2 py-0.5 text-[11px] font-semibold text-success-fg"
          >
            <FormattedMessage id="findSale.summary.status.confirmed" />
          </span>
        )}
      </header>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-neutral-500">
          <FormattedMessage id="findSale.summary.total" />
        </dt>
        <dd
          className="font-mono tabular-nums font-bold text-neutral-900"
          data-testid="find-sale-summary-total"
        >
          {formatIdr(sale.totalIdr)}
        </dd>
        <dt className="text-neutral-500">
          <FormattedMessage id="findSale.summary.tender" />
        </dt>
        <dd data-testid="find-sale-summary-tender">{describeTender(sale.tenders, intl)}</dd>
        <dt className="text-neutral-500">
          <FormattedMessage id="findSale.summary.createdAt" />
        </dt>
        <dd data-testid="find-sale-summary-created-at">
          <FormattedDate value={sale.createdAt} day="2-digit" month="short" year="numeric" />{" "}
          <FormattedTime value={sale.createdAt} hour="2-digit" minute="2-digit" />
        </dd>
        <dt className="text-neutral-500">
          <FormattedMessage id="findSale.summary.cashier" />
        </dt>
        <dd className="font-mono text-xs break-all text-neutral-700">{sale.clerkId}</dd>
      </dl>

      <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-100">
        {sale.items.map((line) => (
          <li
            key={line.itemId}
            className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
            data-testid="find-sale-summary-line"
          >
            <span className="truncate text-neutral-800">
              {line.quantity}× <span className="font-mono text-xs">{line.itemId}</span>
            </span>
            <span className="font-mono tabular-nums text-neutral-900">
              {formatIdr(line.lineTotalIdr)}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2 sm:flex-row" data-testid="find-sale-actions">
        <button
          type="button"
          onClick={onReprintClick}
          disabled={voided}
          data-testid="find-sale-reprint"
          className={[
            "h-12 flex-1 rounded-md text-base font-semibold",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
            voided
              ? "bg-neutral-200 text-neutral-500"
              : "bg-primary-600 text-white active:bg-primary-700",
          ].join(" ")}
        >
          <FormattedMessage id="findSale.cta.reprint" />
        </button>
        <button
          type="button"
          onClick={onVoidClick}
          disabled={!voidAllowed}
          data-testid="find-sale-void"
          className={[
            "h-12 flex-1 rounded-md text-base font-semibold",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
            voidAllowed
              ? "bg-red-700 text-white active:bg-red-800"
              : "bg-neutral-200 text-neutral-500",
          ].join(" ")}
        >
          <FormattedMessage id="findSale.cta.void" />
        </button>
      </div>

      {/*
       * When void is blocked we keep the disabled button (so the affordance
       * is visible to merchant + manager-PIN holder) and surface the reason
       * just below — re-using the SaleVoidScreen's id-ID messages so the
       * copy stays in lockstep with the actual void screen.
       */}
      {!voidAllowed && !voided ? (
        <p
          role="status"
          data-testid="find-sale-void-blocked"
          className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-xs text-warning-fg"
        >
          <FormattedMessage
            id={eligibility.kind === "blocked" ? eligibility.messageId : "void.error.outside_shift"}
          />
        </p>
      ) : null}

      <Link
        to="/sales/history"
        className="block text-center text-xs font-semibold text-primary-700 hover:text-primary-800"
        data-testid="find-sale-history-link"
      >
        <FormattedMessage id="findSale.history.link" />
      </Link>
    </section>
  );
}

const TENDER_LABEL_IDS = {
  cash: "receipt.history.row.tender.cash",
  qris: "receipt.history.row.tender.qris",
  qris_static: "receipt.history.row.tender.qris_static",
  card: "receipt.history.row.tender.card",
  other: "receipt.history.row.tender.other",
} as const;

function describeTender(tenders: PendingSale["tenders"], intl: ReturnType<typeof useIntl>): string {
  if (tenders.length === 0) {
    return intl.formatMessage({ id: "receipt.history.row.tender.other" });
  }
  const methods = new Set(tenders.map((t) => t.method));
  if (methods.size > 1) {
    return intl.formatMessage({ id: "receipt.history.row.tender.mixed" });
  }
  const method = tenders[0]!.method;
  return intl.formatMessage({ id: TENDER_LABEL_IDS[method] });
}
