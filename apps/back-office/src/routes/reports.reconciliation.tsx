import { useMemo } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { useOutlets, useReconciliation } from "../data/useStore";
import type { ReconciliationRow } from "../data/types";
import { formatRupiah } from "../lib/format";
import { loadSession, roleCanManage } from "../lib/session";

/*
 * Reconciliation report — M3 static-QRIS reconciliation surface, plus
 * KASA-250 per-outlet EOD CSV export.
 *
 * The actual EOD rows are written by `services/eod` on the server
 * (ARCHITECTURE.md §4 `end_of_day`); this screen reads them and shows
 * the static-QRIS counted vs Midtrans-settled variance. The "Unduh
 * CSV" affordance hits `GET /v1/eod/{eodId}/export.csv` directly so
 * the browser handles the download with the server-rendered
 * `Content-Disposition` filename — no JS file-builder needed and the
 * CSV is server-authoritative for bookkeeping. Owner/manager only;
 * cashier/read-only roles see the column but the link is hidden so
 * URL sharing matches the route guard's 403.
 */

const EOD_EXPORT_PATH = "/v1/eod";

export function ReconciliationScreen() {
  const rows = useReconciliation();
  const outlets = useOutlets();
  const intl = useIntl();
  const outletById = useMemo(() => new Map(outlets.map((o) => [o.id, o])), [outlets]);
  const session = loadSession();
  const canExport = !!session && roleCanManage(session.role);

  const columns: DataTableColumn<ReconciliationRow>[] = [
    {
      key: "outlet",
      header: <FormattedMessage id="reconciliation.col.outlet" />,
      render: (r) => outletById.get(r.outletId)?.name ?? r.outletId,
    },
    {
      key: "date",
      header: <FormattedMessage id="reconciliation.col.date" />,
      render: (r) => r.businessDate,
    },
    {
      key: "static_qris",
      header: <FormattedMessage id="reconciliation.col.static_qris" />,
      numeric: true,
      render: (r) => formatRupiah(r.staticQrisCounted),
    },
    {
      key: "settled",
      header: <FormattedMessage id="reconciliation.col.settled" />,
      numeric: true,
      render: (r) => formatRupiah(r.midtransSettled),
    },
    {
      key: "variance",
      header: <FormattedMessage id="reconciliation.col.variance" />,
      numeric: true,
      render: (r) => formatRupiah(r.variance),
    },
    {
      key: "status",
      header: <FormattedMessage id="reconciliation.col.status" />,
      render: (r) => r.status,
    },
    {
      key: "csv",
      header: <FormattedMessage id="reconciliation.col.csv" />,
      align: "right",
      render: (r) => {
        if (!canExport || !r.eodId) {
          return (
            <span className="text-xs text-neutral-500">
              <FormattedMessage id="reconciliation.csv.unavailable" />
            </span>
          );
        }
        return (
          <a
            href={`${EOD_EXPORT_PATH}/${r.eodId}/export.csv`}
            className="text-sm font-medium text-primary-fg underline underline-offset-2 hover:text-primary-fg-hover"
            data-testid={`csv-download-${r.eodId}`}
          >
            <FormattedMessage id="reconciliation.csv.download" />
          </a>
        );
      },
    },
  ];

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="reconciliation.heading" />
        </h1>
      </header>

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(r) => r.id}
        emptyState={<FormattedMessage id="reconciliation.empty" />}
        caption={intl.formatMessage({ id: "reconciliation.heading" })}
      />
    </section>
  );
}
