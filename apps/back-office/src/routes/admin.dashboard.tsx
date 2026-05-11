import { useEffect, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import type { DashboardSummaryResponse } from "@kassa/schemas/dashboard";
import {
  DashboardFetchError,
  fetchDashboardSummary,
  type DashboardErrorCode,
} from "../data/api/dashboard";
import { useOutlets } from "../data/useStore";
import { formatRupiah } from "../lib/format";
import { loadSession, roleIsOwner } from "../lib/session";

/*
 * Back-office daily dashboard (KASA-237).
 *
 * Default landing page for owner / manager roles. Three sections:
 *
 *   1. Header tiles — gross revenue, net (post-PPN), transaction count,
 *      average ticket, plus a tender-mix breakdown rendered as percentages.
 *   2. Top-5 leaderboards — by revenue and by quantity, side-by-side.
 *   3. Filters — outlet pill (multi-outlet merchants only) and a date-scope
 *      toggle (today / yesterday / last 7 days). Both regenerate the
 *      `from`/`to` window the server aggregates over.
 *
 * The single-outlet case (every manager-tier session today, since per-staff
 * outlet binding lands later) hides the outlet pill rather than rendering a
 * pill with one option — KASA-237 AC: "manager scoped to one outlet does not
 * see the selector at all".
 *
 * Empty-state copy distinguishes "no sales yet" (zero `saleCount`) from
 * "Rp 0" — pilot merchants explicitly asked for that on day-zero.
 */

type DateScope = "today" | "yesterday" | "last_7_days";

interface DateWindow {
  from: string;
  to: string;
}

const JAKARTA_TZ = "Asia/Jakarta";

/**
 * The merchant calendar is Asia/Jakarta (`outlets.timezone` default,
 * ARCHITECTURE.md §3.2). Walking back N days uses an `Intl.DateTimeFormat`
 * round-trip rather than `Date` math so DST-style edge cases surface from
 * the locale's own rules — relevant once outlets in non-WIB zones land.
 */
function jakartaDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JAKARTA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") lookup[part.type] = part.value;
  }
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function shiftDays(iso: string, days: number): string {
  // Treat the date as midnight UTC for arithmetic; we only ever read
  // year/month/day off the result so a fixed UTC offset stays correct.
  const t = Date.parse(`${iso}T00:00:00.000Z`);
  const shifted = new Date(t + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

function windowFor(scope: DateScope, now: Date = new Date(Date.now())): DateWindow {
  const today = jakartaDate(now);
  switch (scope) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = shiftDays(today, -1);
      return { from: y, to: y };
    }
    case "last_7_days":
      return { from: shiftDays(today, -6), to: today };
  }
}

const SCOPES: readonly DateScope[] = ["today", "yesterday", "last_7_days"];

/**
 * Total tender amount across the mix; used to derive each row's percentage.
 * When the merchant has zero tenders the total is 0 and the UI suppresses
 * the section entirely (the empty-state copy renders instead).
 */
function tenderMixTotal(summary: DashboardSummaryResponse): number {
  let total = 0;
  for (const slice of summary.tenderMix) total += slice.amountIdr;
  return total;
}

function tenderPercent(amountIdr: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((amountIdr / total) * 100);
}

const PERCENT_FORMAT = new Intl.NumberFormat("id-ID", {
  style: "percent",
  maximumFractionDigits: 0,
});

const QUANTITY_FORMAT = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 2,
});

function errorMessageId(code: DashboardErrorCode): string {
  switch (code) {
    case "unauthorized":
    case "forbidden":
      return "guard.forbidden.body";
    case "not_configured":
      return "login.error.notConfigured";
    case "network_error":
      return "login.error.network";
    default:
      return "dashboard.error.body";
  }
}

export function AdminDashboardScreen() {
  const intl = useIntl();
  const session = loadSession();
  const outlets = useOutlets();
  const isOwner = !!session && roleIsOwner(session.role);
  const showOutletSelector = outlets.length > 1;

  const [scope, setScope] = useState<DateScope>("today");
  const [outletId, setOutletId] = useState<string | null>(null);
  const [summary, setSummary] = useState<DashboardSummaryResponse | null>(null);
  const [errorCode, setErrorCode] = useState<DashboardErrorCode | null>(null);
  const [loading, setLoading] = useState(false);

  const window = useMemo(() => windowFor(scope), [scope]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setErrorCode(null);
    fetchDashboardSummary(
      { outletId, from: window.from, to: window.to },
      { signal: controller.signal },
    )
      .then((res) => {
        setSummary(res);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setSummary(null);
        setErrorCode(err instanceof DashboardFetchError ? err.code : "unknown");
        setLoading(false);
      });
    return () => controller.abort();
  }, [outletId, window.from, window.to]);

  const tenderTotal = summary ? tenderMixTotal(summary) : 0;
  const isEmpty = summary !== null && summary.saleCount === 0;
  const showFigures = summary !== null && !isEmpty;

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="dashboard.heading" />
        </h1>
        <p className="text-sm text-neutral-600">
          <FormattedMessage id="dashboard.subheading" />
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        {showOutletSelector ? (
          <label className="flex items-center gap-2 text-sm font-medium text-neutral-700">
            <span>
              <FormattedMessage id="dashboard.outlet.label" />
            </span>
            <select
              data-testid="dashboard-outlet-select"
              className="rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-800"
              value={outletId ?? ""}
              onChange={(e) => setOutletId(e.target.value === "" ? null : e.target.value)}
            >
              {isOwner ? (
                <option value="">{intl.formatMessage({ id: "dashboard.outlet.all" })}</option>
              ) : null}
              {outlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div
          role="tablist"
          aria-label="date-scope"
          className="flex rounded-full bg-neutral-100 p-1"
        >
          {SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scope === s}
              data-testid={`dashboard-scope-${s}`}
              onClick={() => setScope(s)}
              className={[
                "rounded-full px-4 py-1.5 text-sm font-semibold transition-colors",
                scope === s
                  ? "bg-white text-primary-700 shadow-sm"
                  : "text-neutral-600 hover:text-neutral-800",
              ].join(" ")}
            >
              <FormattedMessage id={`dashboard.scope.${s}`} />
            </button>
          ))}
        </div>
      </div>

      {loading && summary === null ? (
        <p className="text-sm text-neutral-500" role="status">
          <FormattedMessage id="dashboard.loading" />
        </p>
      ) : null}

      {errorCode !== null ? (
        <div role="alert" className="rounded-md border border-danger-fg/30 bg-danger-bg/40 p-4">
          <h2 className="text-sm font-semibold text-danger-fg">
            <FormattedMessage id="dashboard.error.heading" />
          </h2>
          <p className="mt-1 text-sm text-neutral-700">
            <FormattedMessage id={errorMessageId(errorCode)} />
          </p>
        </div>
      ) : null}

      {isEmpty ? (
        <div
          data-testid="dashboard-empty"
          className="rounded-md border border-neutral-200 bg-white p-8 text-center"
        >
          <p className="text-base font-semibold text-neutral-700">
            <FormattedMessage id="dashboard.empty" />
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            <FormattedMessage id="dashboard.empty.subheading" />
          </p>
        </div>
      ) : null}

      {showFigures ? (
        <>
          <div className="grid grid-cols-1 gap-4 laptop:grid-cols-4">
            <Tile
              labelId="dashboard.tile.gross"
              value={formatRupiah(summary.grossIdr)}
              testId="dashboard-tile-gross"
            />
            <Tile
              labelId="dashboard.tile.net"
              value={formatRupiah(summary.netIdr)}
              testId="dashboard-tile-net"
            />
            <Tile
              labelId="dashboard.tile.sale_count"
              value={QUANTITY_FORMAT.format(summary.saleCount)}
              testId="dashboard-tile-sale-count"
            />
            <Tile
              labelId="dashboard.tile.average_ticket"
              value={formatRupiah(summary.averageTicketIdr)}
              testId="dashboard-tile-average-ticket"
            />
          </div>

          {summary.tenderMix.length > 0 ? (
            <section
              aria-labelledby="dashboard-tender-mix"
              className="rounded-md border border-neutral-200 bg-white p-4"
            >
              <h2
                id="dashboard-tender-mix"
                className="text-sm font-semibold uppercase tracking-wide text-neutral-500"
              >
                <FormattedMessage id="dashboard.tile.tender_mix" />
              </h2>
              <ul className="mt-3 grid grid-cols-1 gap-3 laptop:grid-cols-3">
                {summary.tenderMix.map((slice) => (
                  <li
                    key={slice.method}
                    data-testid={`dashboard-tender-${slice.method}`}
                    className="flex flex-col gap-1 rounded-md bg-neutral-50 p-3"
                  >
                    <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                      <FormattedMessage id={`dashboard.tender.${slice.method}`} />
                    </span>
                    <span className="text-lg font-semibold text-neutral-900 tabular-nums">
                      {formatRupiah(slice.amountIdr)}
                    </span>
                    <span className="text-xs text-neutral-500 tabular-nums">
                      {PERCENT_FORMAT.format(tenderPercent(slice.amountIdr, tenderTotal) / 100)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="grid grid-cols-1 gap-4 laptop:grid-cols-2">
            <TopItemsCard
              testId="dashboard-top-revenue"
              titleId="dashboard.top_items.by_revenue"
              valueColumnId="dashboard.top_items.col.revenue"
              rows={summary.topItemsByRevenue}
              renderValue={(row) => formatRupiah(row.revenueIdr)}
            />
            <TopItemsCard
              testId="dashboard-top-quantity"
              titleId="dashboard.top_items.by_quantity"
              valueColumnId="dashboard.top_items.col.quantity"
              rows={summary.topItemsByQuantity}
              renderValue={(row) => QUANTITY_FORMAT.format(row.quantity)}
            />
          </div>
        </>
      ) : null}
    </section>
  );
}

function Tile({ labelId, value, testId }: { labelId: string; value: string; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="rounded-md border border-neutral-200 bg-white p-4 shadow-sm"
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        <FormattedMessage id={labelId} />
      </div>
      <div className="mt-2 text-2xl font-bold text-neutral-900 tabular-nums">{value}</div>
    </div>
  );
}

interface TopItemsCardProps {
  testId: string;
  titleId: string;
  valueColumnId: string;
  rows: DashboardSummaryResponse["topItemsByRevenue"];
  renderValue: (row: DashboardSummaryResponse["topItemsByRevenue"][number]) => string;
}

function TopItemsCard({ testId, titleId, valueColumnId, rows, renderValue }: TopItemsCardProps) {
  return (
    <section
      data-testid={testId}
      aria-labelledby={`${testId}-heading`}
      className="rounded-md border border-neutral-200 bg-white p-4"
    >
      <h2
        id={`${testId}-heading`}
        className="text-sm font-semibold uppercase tracking-wide text-neutral-500"
      >
        <FormattedMessage id={titleId} />
      </h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">
          <FormattedMessage id="dashboard.empty" />
        </p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-neutral-500">
              <th className="py-2">
                <FormattedMessage id="dashboard.top_items.col.name" />
              </th>
              <th className="py-2 text-right">
                <FormattedMessage id={valueColumnId} />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.itemId} className="border-t border-neutral-100">
                <td className="py-2">{row.name}</td>
                <td className="py-2 text-right tabular-nums">{renderValue(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
