import { useEffect, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import type { SaleResponse, SaleSubmitTender } from "@kassa/schemas";
import { Button } from "../components/Button";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { Field, SelectInput, TextInput } from "../components/Field";
import {
  enumerateBusinessDays,
  fetchSalesHistory,
  SalesFetchError,
  type SalesFetchErrorCode,
} from "../data/api/sales";
import { useOutlets, useStaff } from "../data/useStore";
import { formatRupiah, shortId } from "../lib/format";

/*
 * Back-office sales history (KASA-249).
 *
 * Lists confirmed sales for a date range, multi-outlet, filtered by
 * tender method and cashier. Default view is "today × all outlets".
 *
 * Why this page fans the API out client-side: the existing
 * `GET /v1/sales` is keyed on `(outletId, businessDate)` per
 * `@kassa/schemas`'s `saleListQuery`. Pilot merchants top out at 50
 * sales/day/outlet (KASA-68 acceptance suite), so fanning out
 * `(outletIds × days)` for a 7-day window stays well inside the
 * server's bucket cap. Pagination is handled by the shared
 * `DataTable` primitive — server pagination lands when a merchant
 * legitimately exceeds the bucket cap.
 *
 * The "tender" filter exposes the three settlement methods the
 * back-office cares about (cash, dynamic QRIS, static QRIS); the
 * underlying API enum also carries `card`, `other`, and the synthetic
 * uptime-probe tender (KASA-71), which are folded into the table but
 * not surfaced as filter pills.
 */

const JAKARTA_TZ = "Asia/Jakarta";

type TenderFilterKey = "cash" | "qris_dynamic" | "qris_static";
const TENDER_FILTERS: readonly TenderFilterKey[] = ["cash", "qris_dynamic", "qris_static"];

/**
 * Map UI tender keys to the wire `method` values used by
 * `saleSubmitTender`. Dynamic QRIS is `qris` on the wire; the UI keeps
 * the dynamic/static distinction so the back-office reads naturally.
 */
function tenderMatches(saleTender: SaleSubmitTender["method"], key: TenderFilterKey): boolean {
  if (key === "cash") return saleTender === "cash";
  if (key === "qris_dynamic") return saleTender === "qris";
  return saleTender === "qris_static";
}

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

interface Filters {
  /** YYYY-MM-DD inclusive lower bound (Asia/Jakarta business day). */
  from: string;
  /** YYYY-MM-DD inclusive upper bound. */
  to: string;
  /** Empty list ⇒ all outlets in the merchant. */
  outletIds: readonly string[];
  tenders: readonly TenderFilterKey[];
  cashierIds: readonly string[];
}

function defaultFilters(today: string): Filters {
  return {
    from: today,
    to: today,
    outletIds: [],
    tenders: [],
    cashierIds: [],
  };
}

/** Pure filter helper exported for unit tests. */
export function applyClientFilters(
  records: readonly SaleResponse[],
  filters: Pick<Filters, "tenders" | "cashierIds">,
): SaleResponse[] {
  return records.filter((sale) => {
    if (filters.cashierIds.length > 0 && !filters.cashierIds.includes(sale.clerkId)) {
      return false;
    }
    if (filters.tenders.length > 0) {
      const has = sale.tenders.some((t) => filters.tenders.some((k) => tenderMatches(t.method, k)));
      if (!has) return false;
    }
    return true;
  });
}

/* React-key helpers — derive a stable composite from each row's
 * content so the list keys survive sale re-fetches and don't lean on
 * array index (Biome `noArrayIndexKey`). Same sale-row may carry
 * several lines of the same item at different prices, so price and
 * quantity participate in the key too. */
function lineItemKey(line: SaleResponse["items"][number]): string {
  return [
    line.itemId,
    line.bomId ?? "no-bom",
    line.unitPriceIdr,
    line.quantity,
    line.lineTotalIdr,
  ].join("|");
}

function tenderKey(tender: SaleSubmitTender): string {
  return [
    tender.method,
    tender.amountIdr,
    tender.reference ?? "no-ref",
    tender.buyerRefLast4 ?? "no-tail",
  ].join("|");
}

function errorMessageId(code: SalesFetchErrorCode): string {
  switch (code) {
    case "unauthorized":
    case "forbidden":
      return "guard.forbidden.body";
    case "not_configured":
      return "login.error.notConfigured";
    case "network_error":
      return "login.error.network";
    default:
      return "sales.error.body";
  }
}

export function AdminSalesScreen() {
  const intl = useIntl();
  const outlets = useOutlets();
  const staff = useStaff();
  const today = useMemo(() => jakartaToday(), []);

  const [filters, setFilters] = useState<Filters>(() => defaultFilters(today));
  const [records, setRecords] = useState<SaleResponse[]>([]);
  const [errorCode, setErrorCode] = useState<SalesFetchErrorCode | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);

  /**
   * Outlets used for the merchant fan-out. When the user has not
   * selected any outlet pills we send every outlet the back-office
   * knows about for this merchant — same posture as the dashboard's
   * "Semua outlet" default.
   */
  const targetOutletIds = useMemo(() => {
    if (filters.outletIds.length > 0) return filters.outletIds;
    return outlets.map((o) => o.id);
  }, [filters.outletIds, outlets]);

  useEffect(() => {
    if (targetOutletIds.length === 0) {
      setRecords([]);
      setErrorCode(null);
      setLoading(false);
      return;
    }
    if (enumerateBusinessDays(filters.from, filters.to).length === 0) {
      setRecords([]);
      setErrorCode(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setErrorCode(null);
    fetchSalesHistory(
      { outletIds: targetOutletIds, from: filters.from, to: filters.to },
      { signal: controller.signal },
    )
      .then((res) => {
        setRecords(res.records);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setRecords([]);
        setErrorCode(err instanceof SalesFetchError ? err.code : "unknown");
        setLoading(false);
      });
    return () => controller.abort();
  }, [filters.from, filters.to, targetOutletIds]);

  const filtered = useMemo(() => applyClientFilters(records, filters), [records, filters]);

  const outletById = useMemo(() => new Map(outlets.map((o) => [o.id, o])), [outlets]);
  const staffById = useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);

  const selectedSale = useMemo(
    () => filtered.find((s) => s.saleId === selectedSaleId) ?? null,
    [filtered, selectedSaleId],
  );

  const hasNonDefaultFilters =
    filters.outletIds.length > 0 ||
    filters.tenders.length > 0 ||
    filters.cashierIds.length > 0 ||
    filters.from !== today ||
    filters.to !== today;

  const clearFilters = () => {
    setFilters(defaultFilters(today));
    setSelectedSaleId(null);
  };

  const toggleTender = (key: TenderFilterKey) => {
    setFilters((prev) => {
      const next = prev.tenders.includes(key)
        ? prev.tenders.filter((k) => k !== key)
        : [...prev.tenders, key];
      return { ...prev, tenders: next };
    });
    setSelectedSaleId(null);
  };

  const columns: DataTableColumn<SaleResponse>[] = [
    {
      key: "createdAt",
      header: <FormattedMessage id="sales.col.time" />,
      render: (r) => (
        <time dateTime={r.createdAt} className={r.voidedAt ? "text-neutral-400 line-through" : ""}>
          {new Date(r.createdAt).toLocaleString(intl.locale, {
            dateStyle: "short",
            timeStyle: "short",
          })}
        </time>
      ),
    },
    {
      key: "localSaleId",
      header: <FormattedMessage id="sales.col.local_id" />,
      render: (r) => (
        <span className="font-mono text-xs text-neutral-600">{shortId(r.localSaleId, 10)}</span>
      ),
    },
    {
      key: "outlet",
      header: <FormattedMessage id="sales.col.outlet" />,
      render: (r) => outletById.get(r.outletId)?.name ?? shortId(r.outletId),
    },
    {
      key: "cashier",
      header: <FormattedMessage id="sales.col.cashier" />,
      render: (r) => staffById.get(r.clerkId)?.displayName ?? shortId(r.clerkId),
    },
    {
      key: "items",
      header: <FormattedMessage id="sales.col.items" />,
      numeric: true,
      render: (r) => r.items.length,
    },
    {
      key: "gross",
      header: <FormattedMessage id="sales.col.gross" />,
      numeric: true,
      render: (r) => formatRupiah(r.subtotalIdr),
    },
    {
      key: "ppn",
      header: <FormattedMessage id="sales.col.ppn" />,
      numeric: true,
      render: (r) => formatRupiah(r.taxIdr),
    },
    {
      key: "tender",
      header: <FormattedMessage id="sales.col.tender" />,
      render: (r) => renderTenderSummary(r),
    },
    {
      key: "status",
      header: <FormattedMessage id="sales.col.status" />,
      render: (r) =>
        r.voidedAt ? (
          <span
            data-testid="sale-row-status-void"
            className="inline-flex rounded-full bg-danger-bg px-2 py-0.5 text-xs font-medium text-danger-fg"
          >
            <FormattedMessage id="sales.status.voided" />
          </span>
        ) : (
          <span
            data-testid="sale-row-status-confirmed"
            className="inline-flex rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success-fg"
          >
            <FormattedMessage id="sales.status.confirmed" />
          </span>
        ),
    },
  ];

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="sales.heading" />
        </h1>
        <Button variant="ghost" onClick={clearFilters} disabled={!hasNonDefaultFilters}>
          <FormattedMessage id="sales.filters.clear" />
        </Button>
      </header>

      <div
        data-testid="sales-filter-bar"
        className="grid gap-4 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm laptop:grid-cols-4"
      >
        <Field label={<FormattedMessage id="sales.filters.from" />} htmlFor="sales-filter-from">
          <TextInput
            id="sales-filter-from"
            type="date"
            value={filters.from}
            onChange={(e) => {
              setFilters((prev) => ({ ...prev, from: e.target.value }));
              setSelectedSaleId(null);
            }}
          />
        </Field>
        <Field label={<FormattedMessage id="sales.filters.to" />} htmlFor="sales-filter-to">
          <TextInput
            id="sales-filter-to"
            type="date"
            value={filters.to}
            onChange={(e) => {
              setFilters((prev) => ({ ...prev, to: e.target.value }));
              setSelectedSaleId(null);
            }}
          />
        </Field>
        <Field label={<FormattedMessage id="sales.filters.outlet" />} htmlFor="sales-filter-outlet">
          <SelectInput
            id="sales-filter-outlet"
            multiple
            value={filters.outletIds as string[]}
            onChange={(e) => {
              const next = Array.from(e.target.selectedOptions, (o) => o.value);
              setFilters((prev) => ({ ...prev, outletIds: next }));
              setSelectedSaleId(null);
            }}
            className="h-24"
          >
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field
          label={<FormattedMessage id="sales.filters.cashier" />}
          htmlFor="sales-filter-cashier"
        >
          <SelectInput
            id="sales-filter-cashier"
            multiple
            value={filters.cashierIds as string[]}
            onChange={(e) => {
              const next = Array.from(e.target.selectedOptions, (o) => o.value);
              setFilters((prev) => ({ ...prev, cashierIds: next }));
              setSelectedSaleId(null);
            }}
            className="h-24"
          >
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </SelectInput>
        </Field>
        <fieldset className="laptop:col-span-4">
          <legend className="text-sm font-medium text-neutral-800">
            <FormattedMessage id="sales.filters.tender" />
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {TENDER_FILTERS.map((key) => {
              const checked = filters.tenders.includes(key);
              return (
                <label
                  key={key}
                  className={[
                    "inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm",
                    checked
                      ? "border-primary-500 bg-primary-50 text-primary-700"
                      : "border-neutral-300 bg-white text-neutral-700",
                  ].join(" ")}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleTender(key)}
                    className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                  />
                  <FormattedMessage id={`sales.tender.${key}`} />
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>

      {loading ? (
        <p data-testid="sales-loading" className="text-sm text-neutral-600">
          <FormattedMessage id="sales.loading" />
        </p>
      ) : null}
      {errorCode ? (
        <div
          role="alert"
          data-testid="sales-error"
          className="rounded-md border border-danger-border bg-danger-bg p-4 text-sm text-danger-fg"
        >
          <p className="font-semibold">
            <FormattedMessage id="sales.error.heading" />
          </p>
          <p>
            <FormattedMessage id={errorMessageId(errorCode)} />
          </p>
        </div>
      ) : null}

      <DataTable
        rows={filtered}
        columns={columns}
        getRowId={(r) => r.saleId}
        selectedId={selectedSaleId}
        onSelect={(row) =>
          setSelectedSaleId((current) => (current === row.saleId ? null : row.saleId))
        }
        emptyState={<FormattedMessage id="sales.empty" />}
        caption={intl.formatMessage({ id: "sales.heading" })}
      />

      {selectedSale ? (
        <SaleDetailPanel
          sale={selectedSale}
          outletName={outletById.get(selectedSale.outletId)?.name ?? ""}
          cashierName={staffById.get(selectedSale.clerkId)?.displayName ?? selectedSale.clerkId}
        />
      ) : null}
    </section>
  );
}

function renderTenderSummary(sale: SaleResponse) {
  if (sale.tenders.length === 0) return null;
  const t = sale.tenders[0]!;
  const labelKey = `sales.tender.${methodToFilterKey(t.method)}`;
  return (
    <span className="inline-flex items-center gap-2">
      <FormattedMessage id={labelKey} />
      {t.buyerRefLast4 ? (
        <span className="font-mono text-xs text-neutral-500">····{t.buyerRefLast4}</span>
      ) : null}
    </span>
  );
}

function methodToFilterKey(method: SaleSubmitTender["method"]): string {
  switch (method) {
    case "cash":
      return "cash";
    case "qris":
      return "qris_dynamic";
    case "qris_static":
      return "qris_static";
    default:
      return "other";
  }
}

/* Receipt-mirror panel — DESIGN-SYSTEM §6.10. Renders the line-item
 * block and a printed-style receipt summary inline so the manager can
 * audit a single sale without opening the POS surface. The POS-side
 * receipt component is still a thin placeholder, so the relevant
 * fields are reconstructed here from the `SaleResponse`. */
function SaleDetailPanel({
  sale,
  outletName,
  cashierName,
}: {
  sale: SaleResponse;
  outletName: string;
  cashierName: string;
}) {
  return (
    <div
      data-testid="sale-detail-panel"
      className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm"
    >
      <div className="grid gap-6 laptop:grid-cols-2">
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            <FormattedMessage id="sales.detail.line_items" />
          </h2>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th className="py-1">
                  <FormattedMessage id="sales.detail.item" />
                </th>
                <th className="py-1 text-right">
                  <FormattedMessage id="sales.detail.qty" />
                </th>
                <th className="py-1 text-right">
                  <FormattedMessage id="sales.detail.line_total" />
                </th>
              </tr>
            </thead>
            <tbody>
              {sale.items.map((line) => (
                <tr key={lineItemKey(line)} className="text-neutral-800">
                  <td className="py-1 font-mono text-xs">{shortId(line.itemId, 10)}</td>
                  <td className="py-1 text-right tabular-nums">{line.quantity}</td>
                  <td className="py-1 text-right tabular-nums">
                    {formatRupiah(line.lineTotalIdr)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section
          aria-label="receipt-mirror"
          className="rounded-md bg-neutral-50 p-4 font-mono text-xs text-neutral-700"
        >
          <div className="text-center font-semibold uppercase tracking-wide">
            {outletName || sale.name}
          </div>
          <hr className="my-2 border-dashed border-neutral-300" />
          <dl className="grid grid-cols-2 gap-y-1">
            <dt>
              <FormattedMessage id="sales.detail.cashier" />
            </dt>
            <dd className="text-right">{cashierName}</dd>
            <dt>
              <FormattedMessage id="sales.detail.local_sale_id" />
            </dt>
            <dd className="break-all text-right">{sale.localSaleId}</dd>
            <dt>
              <FormattedMessage id="sales.detail.server_id" />
            </dt>
            <dd className="break-all text-right">{sale.saleId}</dd>
            <dt>
              <FormattedMessage id="sales.detail.confirmed_at" />
            </dt>
            <dd className="text-right">{new Date(sale.createdAt).toLocaleString()}</dd>
          </dl>
          <hr className="my-2 border-dashed border-neutral-300" />
          <div className="space-y-1">
            <Row
              label={<FormattedMessage id="sales.detail.gross" />}
              value={formatRupiah(sale.subtotalIdr)}
            />
            <Row
              label={<FormattedMessage id="sales.detail.ppn" />}
              value={formatRupiah(sale.taxIdr)}
            />
            <Row
              label={<FormattedMessage id="sales.detail.total" />}
              value={formatRupiah(sale.totalIdr)}
              emphasised
            />
          </div>
          <hr className="my-2 border-dashed border-neutral-300" />
          <ul className="space-y-1">
            {sale.tenders.map((t) => (
              <li key={tenderKey(t)} className="flex justify-between">
                <span>
                  <FormattedMessage id={`sales.tender.${methodToFilterKey(t.method)}`} />
                </span>
                <span className="tabular-nums">{formatRupiah(t.amountIdr)}</span>
              </li>
            ))}
            {sale.tenders[0]?.buyerRefLast4 ? (
              <li className="flex justify-between text-neutral-500">
                <span>
                  <FormattedMessage id="sales.detail.reference" />
                </span>
                <span>····{sale.tenders[0].buyerRefLast4}</span>
              </li>
            ) : null}
          </ul>
          {sale.voidedAt ? (
            <p className="mt-3 text-center font-semibold uppercase text-danger-fg">
              <FormattedMessage id="sales.status.voided" />
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  emphasised,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  emphasised?: boolean;
}) {
  return (
    <div className={["flex justify-between", emphasised ? "font-semibold" : ""].join(" ")}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
