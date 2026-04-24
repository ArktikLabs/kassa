import { useMemo } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { useOutlets, useReconciliation } from "../data/useStore";
import type { ReconciliationRow } from "../data/types";
import { formatRupiah } from "../lib/format";

/*
 * Reconciliation report — M3 static-QRIS reconciliation surface.
 *
 * The actual EOD rows are written by `services/eod` on the server
 * (ARCHITECTURE.md §4 `end_of_day`); this screen reads them and shows
 * the static-QRIS counted vs Midtrans-settled variance. We scaffold
 * the empty-state and column layout now so the API feature can land
 * without blocking on UI design.
 */

export function ReconciliationScreen() {
  const rows = useReconciliation();
  const outlets = useOutlets();
  const intl = useIntl();
  const outletById = useMemo(
    () => new Map(outlets.map((o) => [o.id, o])),
    [outlets],
  );

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
