import { useEffect, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import type { SalesSummaryGroupBy, SalesSummaryResponse } from "@kassa/schemas/salesSummary";
import { Button } from "../components/Button";
import {
  fetchSalesSummary,
  SalesSummaryFetchError,
  type SalesSummaryErrorCode,
} from "../data/api/salesSummary";
import { useOutlets } from "../data/useStore";
import { formatRupiah } from "../lib/format";
import {
  buildSalesSummaryCsv,
  openSalesSummaryPrintWindow,
  type SalesSummaryCsvInput,
} from "../lib/salesSummary";

/*
 * KASA-327 — "Ringkasan periode" panel embedded on `/admin/sales`.
 *
 * Reuses the page's `from`/`to`/`outletId` filters (the panel does not
 * own its own filters — it follows the table). Exposes a groupBy switch
 * (day / outlet / tender / item) plus two export buttons:
 *
 *   - "Unduh CSV" — one row per groupBy bucket, IDR-formatted numbers
 *     written without a thousands separator so Excel / Sheets parse the
 *     cell as a number.
 *   - "Unduh PDF" — opens a print-only window with the merchant header,
 *     totals table, breakdown, and date range footer; the browser's
 *     "Save as PDF" handler is the universal-fallback PDF path (KASA-309
 *     introduces a custom encoder for receipts; the back-office report
 *     reuses the system print pipeline for fidelity to the on-screen
 *     theme without dragging a heavy PDF library into the bundle).
 *
 * The 92-day cap is surfaced inline via the `range_too_large` error
 * code returned by the API — the panel renders a non-scary copy line
 * instead of an alert toast or a 500 page.
 */

const GROUP_BY_OPTIONS: readonly SalesSummaryGroupBy[] = ["day", "outlet", "tender", "item"];

export interface SalesSummaryPanelProps {
  outletId: string | null;
  from: string;
  to: string;
}

function errorMessageId(code: SalesSummaryErrorCode): string {
  switch (code) {
    case "range_too_large":
      return "sales.summary.error.range_too_large";
    case "unauthorized":
    case "forbidden":
      return "guard.forbidden.body";
    case "not_configured":
      return "login.error.notConfigured";
    case "network_error":
      return "login.error.network";
    default:
      return "sales.summary.error.body";
  }
}

export function SalesSummaryPanel({ outletId, from, to }: SalesSummaryPanelProps) {
  const intl = useIntl();
  const outlets = useOutlets();
  const [groupBy, setGroupBy] = useState<SalesSummaryGroupBy>("day");
  const [summary, setSummary] = useState<SalesSummaryResponse | null>(null);
  const [errorCode, setErrorCode] = useState<SalesSummaryErrorCode | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setErrorCode(null);
    fetchSalesSummary({ outletId, from, to, groupBy }, { signal: controller.signal })
      .then((res) => {
        setSummary(res);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setSummary(null);
        setErrorCode(err instanceof SalesSummaryFetchError ? err.code : "unknown");
        setLoading(false);
      });
    return () => controller.abort();
  }, [outletId, from, to, groupBy]);

  const outletLabelById = useMemo(() => new Map(outlets.map((o) => [o.id, o.name])), [outlets]);

  // Resolve human labels for outlet-grouped rows on the client (the API
  // emits outlet UUIDs as both `key` and `label` — see the API comment in
  // `packages/schemas/src/salesSummary.ts`).
  const groupRows = useMemo(() => {
    if (!summary) return [];
    if (summary.groupBy !== "outlet") return summary.groups;
    return summary.groups.map((row) => ({
      ...row,
      label: outletLabelById.get(row.key) ?? row.label,
    }));
  }, [summary, outletLabelById]);

  const handleCsvDownload = () => {
    if (!summary) return;
    const input: SalesSummaryCsvInput = {
      summary: { ...summary, groups: groupRows },
      groupByLabel: intl.formatMessage({ id: `sales.summary.groupBy.${summary.groupBy}` }),
      headerLabels: {
        key: intl.formatMessage({ id: `sales.summary.csv.key.${summary.groupBy}` }),
        label: intl.formatMessage({ id: `sales.summary.csv.label.${summary.groupBy}` }),
        gross: intl.formatMessage({ id: "sales.summary.csv.gross" }),
        discount: intl.formatMessage({ id: "sales.summary.csv.discount" }),
        tax: intl.formatMessage({ id: "sales.summary.csv.tax" }),
        net: intl.formatMessage({ id: "sales.summary.csv.net" }),
        saleCount: intl.formatMessage({ id: "sales.summary.csv.saleCount" }),
        refundCount: intl.formatMessage({ id: "sales.summary.csv.refundCount" }),
        refundIdr: intl.formatMessage({ id: "sales.summary.csv.refundIdr" }),
        quantity: intl.formatMessage({ id: "sales.summary.csv.quantity" }),
      },
    };
    const blob = new Blob([buildSalesSummaryCsv(input)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kassa-ringkasan-${summary.from}_${summary.to}_${summary.groupBy}.csv`;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const handlePdfDownload = () => {
    if (!summary) return;
    openSalesSummaryPrintWindow({
      summary: { ...summary, groups: groupRows },
      headingLabel: intl.formatMessage({ id: "sales.summary.heading" }),
      groupByLabel: intl.formatMessage({ id: `sales.summary.groupBy.${summary.groupBy}` }),
      groupByColumnLabel: intl.formatMessage({
        id: `sales.summary.csv.label.${summary.groupBy}`,
      }),
      tenderLabelsByMethod: {
        cash: intl.formatMessage({ id: "sales.tender.cash" }),
        qris_dynamic: intl.formatMessage({ id: "sales.tender.qris_dynamic" }),
        qris_static: intl.formatMessage({ id: "sales.tender.qris_static" }),
      },
      labels: {
        gross: intl.formatMessage({ id: "sales.summary.tile.gross" }),
        discount: intl.formatMessage({ id: "sales.summary.tile.discount" }),
        tax: intl.formatMessage({ id: "sales.summary.tile.tax" }),
        net: intl.formatMessage({ id: "sales.summary.tile.net" }),
        saleCount: intl.formatMessage({ id: "sales.summary.tile.sale_count" }),
        refundCount: intl.formatMessage({ id: "sales.summary.tile.refund_count" }),
        refundIdr: intl.formatMessage({ id: "sales.summary.tile.refund_amount" }),
        tenderMix: intl.formatMessage({ id: "sales.summary.tile.tender_mix" }),
        topItems: intl.formatMessage({ id: "sales.summary.top_items" }),
        breakdown: intl.formatMessage({ id: "sales.summary.breakdown" }),
        rangeFooter: intl.formatMessage(
          { id: "sales.summary.range_footer" },
          { from: summary.from, to: summary.to },
        ),
      },
    });
  };

  const showSummary = summary !== null && errorCode === null;
  const downloadDisabled = !summary || errorCode !== null;

  return (
    <section
      data-testid="sales-summary-panel"
      aria-labelledby="sales-summary-heading"
      className="space-y-4 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="sales-summary-heading" className="text-lg font-semibold text-neutral-900">
            <FormattedMessage id="sales.summary.heading" />
          </h2>
          <p className="text-sm text-neutral-600">
            <FormattedMessage id="sales.summary.subheading" values={{ from, to }} />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-medium text-neutral-700">
            <span>
              <FormattedMessage id="sales.summary.groupBy.label" />
            </span>
            <select
              data-testid="sales-summary-group-by"
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as SalesSummaryGroupBy)}
            >
              {GROUP_BY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {intl.formatMessage({ id: `sales.summary.groupBy.${option}` })}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="ghost"
            data-testid="sales-summary-export-csv"
            onClick={handleCsvDownload}
            disabled={downloadDisabled}
          >
            <FormattedMessage id="sales.summary.export_csv" />
          </Button>
          <Button
            variant="ghost"
            data-testid="sales-summary-export-pdf"
            onClick={handlePdfDownload}
            disabled={downloadDisabled}
          >
            <FormattedMessage id="sales.summary.export_pdf" />
          </Button>
        </div>
      </header>

      {loading && summary === null ? (
        <p className="text-sm text-neutral-500" role="status">
          <FormattedMessage id="sales.summary.loading" />
        </p>
      ) : null}

      {errorCode !== null ? (
        <div
          role="alert"
          data-testid="sales-summary-error"
          className="rounded-md border border-danger-fg/30 bg-danger-bg/40 p-4"
        >
          <p className="text-sm font-semibold text-danger-fg">
            <FormattedMessage id="sales.summary.error.heading" />
          </p>
          <p className="mt-1 text-sm text-neutral-700">
            <FormattedMessage id={errorMessageId(errorCode)} />
          </p>
        </div>
      ) : null}

      {showSummary && summary ? (
        <>
          <div className="grid grid-cols-2 gap-3 laptop:grid-cols-4">
            <SummaryTile
              labelId="sales.summary.tile.gross"
              value={formatRupiah(summary.grossIdr)}
              testId="sales-summary-tile-gross"
            />
            <SummaryTile
              labelId="sales.summary.tile.discount"
              value={formatRupiah(summary.discountIdr)}
              testId="sales-summary-tile-discount"
            />
            <SummaryTile
              labelId="sales.summary.tile.tax"
              value={formatRupiah(summary.taxIdr)}
              testId="sales-summary-tile-tax"
            />
            <SummaryTile
              labelId="sales.summary.tile.net"
              value={formatRupiah(summary.netIdr)}
              testId="sales-summary-tile-net"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 laptop:grid-cols-3">
            <SummaryTile
              labelId="sales.summary.tile.sale_count"
              value={String(summary.saleCount)}
              testId="sales-summary-tile-sale-count"
            />
            <SummaryTile
              labelId="sales.summary.tile.refund_count"
              value={String(summary.refundCount)}
              testId="sales-summary-tile-refund-count"
            />
            <SummaryTile
              labelId="sales.summary.tile.refund_amount"
              value={formatRupiah(summary.refundIdr)}
              testId="sales-summary-tile-refund-amount"
            />
          </div>

          {summary.tenderMix.length > 0 ? (
            <section
              aria-labelledby="sales-summary-tender-mix"
              data-testid="sales-summary-tender-mix"
            >
              <h3
                id="sales-summary-tender-mix"
                className="text-sm font-semibold uppercase tracking-wide text-neutral-500"
              >
                <FormattedMessage id="sales.summary.tile.tender_mix" />
              </h3>
              <ul className="mt-2 grid grid-cols-1 gap-2 laptop:grid-cols-3">
                {summary.tenderMix.map((slice) => (
                  <li
                    key={slice.method}
                    className="flex justify-between rounded-md bg-neutral-50 px-3 py-2 text-sm"
                  >
                    <span className="font-medium text-neutral-700">
                      <FormattedMessage id={`sales.tender.${slice.method}`} />
                    </span>
                    <span className="tabular-nums text-neutral-900">
                      {formatRupiah(slice.amountIdr)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {groupRows.length > 0 ? (
            <section aria-labelledby="sales-summary-breakdown">
              <h3
                id="sales-summary-breakdown"
                className="text-sm font-semibold uppercase tracking-wide text-neutral-500"
              >
                <FormattedMessage id="sales.summary.breakdown" />
              </h3>
              <table className="mt-2 w-full text-sm" data-testid="sales-summary-breakdown-table">
                <thead>
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    <th className="py-2">
                      <FormattedMessage id={`sales.summary.csv.label.${summary.groupBy}`} />
                    </th>
                    <th className="py-2 text-right">
                      <FormattedMessage id="sales.summary.csv.gross" />
                    </th>
                    {summary.groupBy === "item" ? (
                      <th className="py-2 text-right">
                        <FormattedMessage id="sales.summary.csv.quantity" />
                      </th>
                    ) : (
                      <>
                        <th className="py-2 text-right">
                          <FormattedMessage id="sales.summary.csv.tax" />
                        </th>
                        <th className="py-2 text-right">
                          <FormattedMessage id="sales.summary.csv.net" />
                        </th>
                        <th className="py-2 text-right">
                          <FormattedMessage id="sales.summary.csv.saleCount" />
                        </th>
                        <th className="py-2 text-right">
                          <FormattedMessage id="sales.summary.csv.refundIdr" />
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {groupRows.map((row) => (
                    <tr
                      key={row.key}
                      data-testid="sales-summary-row"
                      className="border-t border-neutral-100 text-neutral-800"
                    >
                      <td className="py-2">{row.label || row.key}</td>
                      <td className="py-2 text-right tabular-nums">{formatRupiah(row.grossIdr)}</td>
                      {summary.groupBy === "item" ? (
                        <td className="py-2 text-right tabular-nums">{row.quantity}</td>
                      ) : (
                        <>
                          <td className="py-2 text-right tabular-nums">
                            {formatRupiah(row.taxIdr)}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {formatRupiah(row.netIdr)}
                          </td>
                          <td className="py-2 text-right tabular-nums">{row.saleCount}</td>
                          <td className="py-2 text-right tabular-nums">
                            {formatRupiah(row.refundIdr)}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : (
            <p className="text-sm text-neutral-500" data-testid="sales-summary-empty">
              <FormattedMessage id="sales.summary.empty" />
            </p>
          )}

          {summary.topItemsByRevenue.length > 0 ? (
            <section aria-labelledby="sales-summary-top-items">
              <h3
                id="sales-summary-top-items"
                className="text-sm font-semibold uppercase tracking-wide text-neutral-500"
              >
                <FormattedMessage id="sales.summary.top_items" />
              </h3>
              <ol
                className="mt-2 grid grid-cols-1 gap-1 text-sm laptop:grid-cols-2"
                data-testid="sales-summary-top-items"
              >
                {summary.topItemsByRevenue.map((row, index) => (
                  <li
                    key={row.itemId}
                    className="flex justify-between rounded-md bg-neutral-50 px-3 py-1.5"
                  >
                    <span>
                      <span className="mr-2 inline-block w-5 text-right text-xs text-neutral-500">
                        {index + 1}.
                      </span>
                      {row.name}
                    </span>
                    <span className="tabular-nums text-neutral-900">
                      {formatRupiah(row.revenueIdr)}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function SummaryTile({
  labelId,
  value,
  testId,
}: {
  labelId: string;
  value: string;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        <FormattedMessage id={labelId} />
      </div>
      <div className="mt-1 text-xl font-bold text-neutral-900 tabular-nums">{value}</div>
    </div>
  );
}
