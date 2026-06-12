import { useEffect, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import type { CashierDayResponse } from "@kassa/schemas/reports";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { Field, SelectInput, TextInput } from "../components/Field";
import {
  cashierDayCsvUrl,
  CashierDayFetchError,
  fetchCashierDayReport,
  type CashierDayErrorCode,
} from "../data/api/cashier-day";
import { useOutlets } from "../data/useStore";
import { formatRupiah } from "../lib/format";

/*
 * Back-office per-cashier daily sales report (KASA-368).
 *
 * Default audience: the owner at shift handover. "What did Siti ring up
 * today, what did she void, what's her cash drawer expecting?" Without this
 * page the owner has to filter the sales list one cashier at a time.
 *
 * Page shape:
 *   - Filters: outlet (single-select, defaults to the first managed outlet)
 *     and date (default = today, max 90 days back).
 *   - Table: one row per cashier with sales count, gross / net / void totals,
 *     tender breakdown (cash, QRIS dynamic, QRIS static), and the expected
 *     drawer ("—" when no shift opened).
 *   - CSV export: hits `/v1/reports/cashier-day/export.csv` directly so the
 *     browser handles the file save with the server-pinned filename — no
 *     client-side CSV builder, no drift between the on-screen totals and
 *     the file's totals row.
 *   - Empty state: rendered in id-ID when no cashier sold on the filter
 *     date, with the export action disabled.
 *
 * RBAC: the router gate (`requireManager`) returns <Forbidden /> for cashier
 * and read-only sessions; this component never renders for them.
 */

const JAKARTA_TZ = "Asia/Jakarta";
const MAX_DAYS_BACK = 90;

function jakartaToday(now: Date = new Date(Date.now())): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JAKARTA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") lookup[part.type] = part.value;
  }
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function shiftDays(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00.000Z`);
  const shifted = new Date(t + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

interface Filters {
  outletId: string | null;
  /** YYYY-MM-DD, Asia/Jakarta business day. */
  businessDate: string;
}

function errorMessageId(code: CashierDayErrorCode): string {
  switch (code) {
    case "unauthorized":
    case "forbidden":
      return "guard.forbidden.body";
    case "not_configured":
      return "login.error.notConfigured";
    case "network_error":
      return "login.error.network";
    default:
      return "cashier_day.error.body";
  }
}

export function AdminCashierDayScreen() {
  const intl = useIntl();
  const outlets = useOutlets();
  const today = useMemo(() => jakartaToday(), []);
  const minDate = useMemo(() => shiftDays(today, -MAX_DAYS_BACK), [today]);

  /**
   * Outlet default — the first outlet visible to the back-office. When the
   * useStore hook hasn't hydrated yet (`outlets.length === 0`) we leave
   * `outletId` null and the effect below skips the fetch.
   */
  const defaultOutletId = outlets[0]?.id ?? null;
  const [filters, setFilters] = useState<Filters>(() => ({
    outletId: defaultOutletId,
    businessDate: today,
  }));

  /**
   * When the outlets list arrives late (first paint races the useStore
   * snapshot) we seed `outletId` from the first hydrated outlet so the
   * user doesn't have to pick one manually.
   */
  useEffect(() => {
    if (filters.outletId === null && defaultOutletId !== null) {
      setFilters((prev) => ({ ...prev, outletId: defaultOutletId }));
    }
  }, [defaultOutletId, filters.outletId]);

  const [report, setReport] = useState<CashierDayResponse | null>(null);
  const [errorCode, setErrorCode] = useState<CashierDayErrorCode | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (filters.outletId === null) {
      setReport(null);
      setErrorCode(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setErrorCode(null);
    fetchCashierDayReport(
      { outletId: filters.outletId, businessDate: filters.businessDate },
      { signal: controller.signal },
    )
      .then((res) => {
        setReport(res);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setReport(null);
        setErrorCode(err instanceof CashierDayFetchError ? err.code : "unknown");
        setLoading(false);
      });
    return () => controller.abort();
  }, [filters.outletId, filters.businessDate]);

  const isEmpty = report !== null && report.rows.length === 0;
  const csvHref =
    filters.outletId !== null && !isEmpty && report !== null
      ? cashierDayCsvUrl({ outletId: filters.outletId, businessDate: filters.businessDate })
      : null;

  const columns: DataTableColumn<CashierDayResponse["rows"][number]>[] = [
    {
      key: "cashier",
      header: <FormattedMessage id="cashier_day.col.cashier" />,
      render: (r) => r.cashierName,
    },
    {
      key: "sale_count",
      header: <FormattedMessage id="cashier_day.col.sale_count" />,
      numeric: true,
      render: (r) => r.saleCount,
    },
    {
      key: "gross",
      header: <FormattedMessage id="cashier_day.col.gross" />,
      numeric: true,
      render: (r) => formatRupiah(r.grossIdr),
    },
    {
      key: "net",
      header: <FormattedMessage id="cashier_day.col.net" />,
      numeric: true,
      render: (r) => formatRupiah(r.netIdr),
    },
    {
      key: "voids",
      header: <FormattedMessage id="cashier_day.col.voids" />,
      numeric: true,
      render: (r) => `${r.voidCount} · ${formatRupiah(r.voidIdr)}`,
    },
    {
      key: "cash",
      header: <FormattedMessage id="cashier_day.col.cash" />,
      numeric: true,
      render: (r) => formatRupiah(tenderAmount(r.tenderMix, "cash")),
    },
    {
      key: "qris_dynamic",
      header: <FormattedMessage id="cashier_day.col.qris_dynamic" />,
      numeric: true,
      render: (r) => formatRupiah(tenderAmount(r.tenderMix, "qris_dynamic")),
    },
    {
      key: "qris_static",
      header: <FormattedMessage id="cashier_day.col.qris_static" />,
      numeric: true,
      render: (r) => formatRupiah(tenderAmount(r.tenderMix, "qris_static")),
    },
    {
      key: "drawer_expected",
      header: <FormattedMessage id="cashier_day.col.drawer_expected" />,
      numeric: true,
      render: (r) =>
        r.drawerExpectedIdr === null ? (
          <span className="text-neutral-400">—</span>
        ) : (
          formatRupiah(r.drawerExpectedIdr)
        ),
    },
  ];

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">
            <FormattedMessage id="cashier_day.heading" />
          </h1>
          <p className="text-sm text-neutral-600">
            <FormattedMessage id="cashier_day.subheading" />
          </p>
        </div>
        {csvHref ? (
          <a
            href={csvHref}
            data-testid="cashier-day-export-csv"
            className="rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-700"
          >
            <FormattedMessage id="cashier_day.export_csv" />
          </a>
        ) : (
          <button
            type="button"
            disabled
            data-testid="cashier-day-export-csv-disabled"
            className="cursor-not-allowed rounded-md bg-neutral-200 px-4 py-2 text-sm font-semibold text-neutral-500"
          >
            <FormattedMessage id="cashier_day.export_csv" />
          </button>
        )}
      </header>

      <div
        data-testid="cashier-day-filter-bar"
        className="grid gap-4 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm laptop:grid-cols-2"
      >
        <Field
          label={<FormattedMessage id="cashier_day.filters.outlet" />}
          htmlFor="cashier-day-outlet"
        >
          <SelectInput
            id="cashier-day-outlet"
            value={filters.outletId ?? ""}
            onChange={(e) => setFilters((prev) => ({ ...prev, outletId: e.target.value || null }))}
          >
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field
          label={<FormattedMessage id="cashier_day.filters.date" />}
          htmlFor="cashier-day-date"
        >
          <TextInput
            id="cashier-day-date"
            type="date"
            value={filters.businessDate}
            min={minDate}
            max={today}
            onChange={(e) => setFilters((prev) => ({ ...prev, businessDate: e.target.value }))}
          />
        </Field>
      </div>

      {loading ? (
        <p data-testid="cashier-day-loading" className="text-sm text-neutral-600">
          <FormattedMessage id="cashier_day.loading" />
        </p>
      ) : null}

      {errorCode ? (
        <div
          role="alert"
          data-testid="cashier-day-error"
          className="rounded-md border border-danger-border bg-danger-bg p-4 text-sm text-danger-fg"
        >
          <p className="font-semibold">
            <FormattedMessage id="cashier_day.error.heading" />
          </p>
          <p>
            <FormattedMessage id={errorMessageId(errorCode)} />
          </p>
        </div>
      ) : null}

      {isEmpty ? (
        <div
          data-testid="cashier-day-empty"
          className="rounded-md border border-neutral-200 bg-white p-8 text-center"
        >
          <p className="text-base font-semibold text-neutral-700">
            <FormattedMessage id="cashier_day.empty" />
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            <FormattedMessage id="cashier_day.empty.subheading" />
          </p>
        </div>
      ) : null}

      {report && !isEmpty ? (
        <>
          <DataTable
            rows={report.rows}
            columns={columns}
            getRowId={(r) => r.cashierStaffId}
            emptyState={<FormattedMessage id="cashier_day.empty" />}
            caption={intl.formatMessage({ id: "cashier_day.heading" })}
          />
          <TotalsCard report={report} />
        </>
      ) : null}
    </section>
  );
}

function TotalsCard({ report }: { report: CashierDayResponse }) {
  return (
    <section
      data-testid="cashier-day-totals"
      aria-labelledby="cashier-day-totals-heading"
      className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm"
    >
      <h2
        id="cashier-day-totals-heading"
        className="text-sm font-semibold uppercase tracking-wide text-neutral-500"
      >
        <FormattedMessage id="cashier_day.totals.heading" />
      </h2>
      <dl className="mt-3 grid gap-3 laptop:grid-cols-4">
        <Stat labelId="cashier_day.totals.sale_count" value={String(report.totals.saleCount)} />
        <Stat labelId="cashier_day.totals.gross" value={formatRupiah(report.totals.grossIdr)} />
        <Stat labelId="cashier_day.totals.net" value={formatRupiah(report.totals.netIdr)} />
        <Stat
          labelId="cashier_day.totals.voids"
          value={`${report.totals.voidCount} · ${formatRupiah(report.totals.voidIdr)}`}
        />
        <Stat
          labelId="cashier_day.totals.cash"
          value={formatRupiah(tenderAmount(report.totals.tenderMix, "cash"))}
        />
        <Stat
          labelId="cashier_day.totals.qris_dynamic"
          value={formatRupiah(tenderAmount(report.totals.tenderMix, "qris_dynamic"))}
        />
        <Stat
          labelId="cashier_day.totals.qris_static"
          value={formatRupiah(tenderAmount(report.totals.tenderMix, "qris_static"))}
        />
        <Stat
          labelId="cashier_day.totals.drawer_expected"
          value={
            report.totals.drawerExpectedIdr === null
              ? "—"
              : formatRupiah(report.totals.drawerExpectedIdr)
          }
        />
      </dl>
    </section>
  );
}

function Stat({ labelId, value }: { labelId: string; value: string }) {
  return (
    <div className="rounded-md bg-neutral-50 p-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        <FormattedMessage id={labelId} />
      </dt>
      <dd className="mt-1 text-lg font-semibold text-neutral-900 tabular-nums">{value}</dd>
    </div>
  );
}

function tenderAmount(
  mix: readonly CashierDayResponse["rows"][number]["tenderMix"][number][],
  method: "cash" | "qris_dynamic" | "qris_static",
): number {
  return mix.find((slice) => slice.method === method)?.amountIdr ?? 0;
}
