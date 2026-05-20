import { useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Button } from "../components/Button";
import { bulkUpsertItems } from "../data/store";
import { useCatalogItems } from "../data/useStore";
import {
  buildCsvTemplate,
  CSV_HEADER,
  CSV_TEMPLATE_FILENAME,
  diffAgainstCatalog,
  parseCsv,
  type ImportDiff,
  type ParsedCsv,
} from "../lib/catalog-import";
import { formatRupiah } from "../lib/format";

/*
 * Owner-only CSV import surface for fast merchant onboarding (KASA-311).
 *
 * Flow: pick CSV → parse client-side → preview rows with per-row errors →
 * diff against existing catalog → confirm-and-import (writes the local
 * scaffold store today; the catalog HTTP integration that hits
 * `POST /v1/catalog/items/bulk` lands with the back-office migration off
 * localStorage, KASA-67 follow-up).
 *
 * The confirm button is gated on zero parse errors so a partial import
 * never lands a half-fixed batch.
 */

export function CatalogImportScreen() {
  const intl = useIntl();
  const existing = useCatalogItems();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [importedSummary, setImportedSummary] = useState<{
    created: number;
    updated: number;
    unchanged: number;
  } | null>(null);

  const diff = useMemo<ImportDiff | null>(
    () => (parsed ? diffAgainstCatalog(parsed, existing) : null),
    [parsed, existing],
  );

  const errorRowCount = useMemo(
    () => (parsed ? parsed.rows.filter((r) => !r.draft).length : 0),
    [parsed],
  );

  const canImport =
    parsed !== null &&
    parsed.fileErrors.length === 0 &&
    errorRowCount === 0 &&
    diff !== null &&
    diff.toCreate.length + diff.toUpdate.length + diff.unchanged.length > 0;

  const downloadTemplate = () => {
    const blob = new Blob([buildCsvTemplate()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = CSV_TEMPLATE_FILENAME;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const onFileChosen = async (file: File | null): Promise<void> => {
    setImportedSummary(null);
    if (!file) {
      setParsed(null);
      setFilename(null);
      return;
    }
    setFilename(file.name);
    // `Blob.text()` is missing on jsdom's File polyfill, so we read via
    // FileReader for browser/jsdom parity. Browsers also handle this path
    // and the wire shape is identical.
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.readAsText(file, "utf-8");
    });
    setParsed(parseCsv(text));
  };

  const reset = () => {
    setParsed(null);
    setFilename(null);
    setImportedSummary(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const confirmImport = () => {
    if (!parsed || !diff || !canImport) return;
    const result = bulkUpsertItems({
      toCreate: diff.toCreate.map((c) => c.draft),
      toUpdate: diff.toUpdate.map((u) => ({ id: u.existing.id, patch: u.draft })),
    });
    setImportedSummary({
      created: result.created,
      updated: result.updated,
      unchanged: diff.unchanged.length,
    });
  };

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">
            <FormattedMessage id="catalog.import.heading" />
          </h1>
          <p className="mt-1 text-sm text-neutral-600">
            <FormattedMessage id="catalog.import.subheading" />
          </p>
        </div>
        <Button variant="ghost" onClick={downloadTemplate}>
          <FormattedMessage id="catalog.import.download_template" />
        </Button>
      </header>

      <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
        <label className="block text-sm font-medium text-neutral-800" htmlFor="catalog-import-file">
          <FormattedMessage id="catalog.import.file_picker" />
        </label>
        <input
          ref={fileInputRef}
          id="catalog-import-file"
          type="file"
          accept=".csv,text/csv"
          className="mt-2 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 file:mr-3 file:rounded file:border-0 file:bg-primary-50 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-primary-700 hover:file:bg-primary-100"
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            void onFileChosen(file);
          }}
        />
        <p className="mt-2 text-xs text-neutral-500">
          <FormattedMessage
            id="catalog.import.columns_hint"
            values={{ columns: CSV_HEADER.join(", ") }}
          />
        </p>
      </div>

      {parsed && filename ? (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-neutral-900">
            <FormattedMessage
              id="catalog.import.preview_heading"
              values={{ file: filename, count: parsed.rows.length }}
            />
          </h2>

          {parsed.fileErrors.length > 0 ? (
            <ul
              className="rounded-md border border-danger-border bg-danger-surface px-4 py-3 text-sm text-danger-fg"
              role="alert"
            >
              {parsed.fileErrors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          ) : null}

          {diff ? (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SummaryStat
                labelId="catalog.import.summary.create"
                value={diff.toCreate.length}
                tone="success"
                testId="summary-create"
              />
              <SummaryStat
                labelId="catalog.import.summary.update"
                value={diff.toUpdate.length}
                tone="primary"
                testId="summary-update"
              />
              <SummaryStat
                labelId="catalog.import.summary.unchanged"
                value={diff.unchanged.length}
                tone="neutral"
                testId="summary-unchanged"
              />
              <SummaryStat
                labelId="catalog.import.summary.skip"
                value={errorRowCount}
                tone={errorRowCount > 0 ? "danger" : "neutral"}
                testId="summary-skip"
              />
            </dl>
          ) : null}

          <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-neutral-200 text-sm">
              <caption className="sr-only">
                <FormattedMessage id="catalog.import.table_caption" />
              </caption>
              <thead className="bg-neutral-50 text-left text-xs font-semibold uppercase tracking-wide text-neutral-600">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">
                    <FormattedMessage id="catalog.col.sku" />
                  </th>
                  <th className="px-3 py-2">
                    <FormattedMessage id="catalog.col.name" />
                  </th>
                  <th className="px-3 py-2">
                    <FormattedMessage id="catalog.col.price" />
                  </th>
                  <th className="px-3 py-2">
                    <FormattedMessage id="catalog.col.uom" />
                  </th>
                  <th className="px-3 py-2">
                    <FormattedMessage id="catalog.import.col.status" />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {parsed.rows.map((row) => {
                  const status = rowStatus(row, diff);
                  return (
                    <tr
                      key={row.line}
                      className={status.kind === "skip" ? "bg-danger-surface/40" : undefined}
                      data-testid={`row-${row.line}`}
                    >
                      <td className="px-3 py-2 text-xs text-neutral-500">{row.line}</td>
                      <td className="px-3 py-2 font-mono text-xs">{row.raw.sku ?? ""}</td>
                      <td className="px-3 py-2">{row.raw.name ?? ""}</td>
                      <td className="px-3 py-2 text-right">
                        {row.draft ? formatRupiah(row.draft.priceIdr) : (row.raw.price_idr ?? "")}
                      </td>
                      <td className="px-3 py-2">{row.raw.uom ?? ""}</td>
                      <td className="px-3 py-2">
                        <StatusCell status={status} intl={intl} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-end gap-3">
            <Button variant="ghost" onClick={reset}>
              <FormattedMessage id="catalog.import.cancel" />
            </Button>
            <Button onClick={confirmImport} disabled={!canImport}>
              <FormattedMessage id="catalog.import.confirm" />
            </Button>
          </div>

          {importedSummary ? (
            <p
              className="rounded-md border border-success-border bg-success-surface px-4 py-3 text-sm text-success-fg"
              role="status"
              data-testid="import-result"
            >
              <FormattedMessage
                id="catalog.import.success"
                values={{
                  created: importedSummary.created,
                  updated: importedSummary.updated,
                  unchanged: importedSummary.unchanged,
                }}
              />
            </p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

type RowStatus =
  | { kind: "create" }
  | { kind: "update" }
  | { kind: "unchanged" }
  | { kind: "skip"; errors: string[] };

function rowStatus(row: ParsedCsv["rows"][number], diff: ImportDiff | null): RowStatus {
  if (!row.draft) return { kind: "skip", errors: row.errors };
  if (!diff) return { kind: "create" };
  if (diff.toCreate.some((c) => c.row === row)) return { kind: "create" };
  if (diff.toUpdate.some((u) => u.row === row)) return { kind: "update" };
  return { kind: "unchanged" };
}

function StatusCell({ status, intl }: { status: RowStatus; intl: ReturnType<typeof useIntl> }) {
  if (status.kind === "skip") {
    return (
      <div className="text-xs text-danger-fg" role="alert">
        <span className="font-semibold uppercase">
          {intl.formatMessage({ id: "catalog.import.status.skip" })}
        </span>
        <ul className="mt-0.5 list-disc pl-4">
          {status.errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      </div>
    );
  }
  const labelId = `catalog.import.status.${status.kind}`;
  const toneClass =
    status.kind === "create"
      ? "bg-success-surface text-success-fg"
      : status.kind === "update"
        ? "bg-primary-50 text-primary-700"
        : "bg-neutral-100 text-neutral-600";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${toneClass}`}>
      {intl.formatMessage({ id: labelId })}
    </span>
  );
}

function SummaryStat({
  labelId,
  value,
  tone,
  testId,
}: {
  labelId: string;
  value: number;
  tone: "success" | "primary" | "neutral" | "danger";
  testId: string;
}) {
  const toneClass =
    tone === "success"
      ? "border-success-border bg-success-surface text-success-fg"
      : tone === "primary"
        ? "border-primary-200 bg-primary-50 text-primary-700"
        : tone === "danger"
          ? "border-danger-border bg-danger-surface text-danger-fg"
          : "border-neutral-200 bg-neutral-50 text-neutral-700";
  return (
    <div className={`rounded-lg border px-4 py-3 ${toneClass}`} data-testid={testId}>
      <dt className="text-xs font-semibold uppercase tracking-wide">
        <FormattedMessage id={labelId} />
      </dt>
      <dd className="mt-1 text-2xl font-bold">{value}</dd>
    </div>
  );
}
