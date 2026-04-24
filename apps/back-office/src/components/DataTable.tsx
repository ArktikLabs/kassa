import { useMemo, useState, type ReactNode } from "react";
import { FormattedMessage } from "react-intl";

/*
 * DataTable — DESIGN-SYSTEM §6.13.
 *
 * - Header row: neutral.50, caption case, sticky on vertical scroll.
 * - Cells: body-sm, divider-bottom, numeric columns right-aligned with
 *   tabular numerals.
 * - Row hover: neutral.50. Selected: primary.50 with a 2px primary.600
 *   indicator.
 * - Pagination: bottom-right, page nav + page count.
 * - Empty: inline empty state (§6.12) rendered inside the table body.
 *
 * The component is deliberately unopinionated about data shape — rows
 * are the caller's type and columns render a cell from each row. That
 * keeps each resource's table a thin, typed adapter.
 */

export type DataTableColumn<Row> = {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  align?: "left" | "right" | "center";
  numeric?: boolean;
  widthClass?: string;
};

export type DataTableProps<Row> = {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowId: (row: Row) => string;
  selectedId?: string | null;
  onSelect?: (row: Row) => void;
  pageSize?: number;
  emptyState?: ReactNode;
  caption?: string;
};

const DEFAULT_PAGE_SIZE = 25;

export function DataTable<Row>({
  columns,
  rows,
  getRowId,
  selectedId,
  onSelect,
  pageSize = DEFAULT_PAGE_SIZE,
  emptyState,
  caption,
}: DataTableProps<Row>) {
  const [page, setPage] = useState(0);
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const visible = useMemo(
    () => rows.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize),
    [rows, clampedPage, pageSize],
  );

  const from = total === 0 ? 0 : clampedPage * pageSize + 1;
  const to = Math.min(total, (clampedPage + 1) * pageSize);

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
      <div className="max-h-[70vh] overflow-auto">
        <table className="min-w-full border-collapse">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="sticky top-0 z-10 bg-neutral-50 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-700">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={[
                    "border-b border-neutral-200 px-4 py-3",
                    col.align === "right" || col.numeric
                      ? "text-right"
                      : col.align === "center"
                        ? "text-center"
                        : "text-left",
                    col.widthClass ?? "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-16 text-center text-neutral-500">
                  {emptyState ?? <FormattedMessage id="table.empty" />}
                </td>
              </tr>
            ) : (
              visible.map((row) => {
                const id = getRowId(row);
                const isSelected = selectedId === id;
                return (
                  <tr
                    key={id}
                    data-testid="data-table-row"
                    data-selected={isSelected || undefined}
                    onClick={onSelect ? () => onSelect(row) : undefined}
                    className={[
                      "group cursor-default text-sm text-neutral-800",
                      "hover:bg-neutral-50",
                      isSelected
                        ? "bg-primary-50 shadow-[inset_2px_0_0_0_var(--color-primary-600)]"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={[
                          "border-b border-neutral-200 px-4 py-3 align-middle",
                          col.numeric ? "text-right tabular-nums" : "",
                          col.align === "right" && !col.numeric ? "text-right" : "",
                          col.align === "center" ? "text-center" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        {col.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-600">
        <span data-testid="data-table-range">
          <FormattedMessage id="table.pagination.range" values={{ from, to, total }} />
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={clampedPage === 0}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1 font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
          >
            <FormattedMessage id="table.pagination.prev" />
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={clampedPage >= pageCount - 1}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1 font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
          >
            <FormattedMessage id="table.pagination.next" />
          </button>
        </div>
      </div>
    </div>
  );
}
