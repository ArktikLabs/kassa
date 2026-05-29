import type { CashierDayResponse } from "@kassa/schemas/reports";

/*
 * Per-cashier daily sales CSV builder (KASA-368).
 *
 * Format choices match `eod/csv.ts` so a merchant who runs both files through
 * the same bookkeeper-side import keeps a single locale dance:
 *
 *   - UTF-8 BOM prefix so Excel-id picks up the encoding without a wizard
 *   - `;` (semicolon) field separator (id-ID Excel default)
 *   - RFC-4180 quoting: only quote a field that contains the separator, a
 *     `"`, CR, or LF; double `"` inside a quoted field
 *   - CRLF line endings (RFC-4180) so the file opens identically in
 *     LibreOffice/Linux and Excel/Windows
 *   - Numeric columns are plain integer rupiah (no thousands grouping, no
 *     decimal places); empty cell for "no data" (e.g. drawer-expected when
 *     no shift opened)
 *
 * The output document is `header + one row per cashier + one totals row`.
 * The owner asked for that explicitly: at shift handover they want each
 * cashier's slice AND the day's banked total without re-summing in Excel.
 */

export const CASHIER_DAY_CSV_BOM = "﻿";
export const CASHIER_DAY_CSV_SEPARATOR = ";";
export const CASHIER_DAY_CSV_LINE_ENDING = "\r\n";

/** Column order is the contract — keep in sync with the issue body. */
export const CASHIER_DAY_CSV_COLUMNS = [
  "cashier",
  "sale_count",
  "gross",
  "net",
  "void_count",
  "void_total",
  "cash",
  "qris_dynamic",
  "qris_static",
  "drawer_expected",
] as const;

export type CashierDayCsvColumn = (typeof CASHIER_DAY_CSV_COLUMNS)[number];

export interface CashierDayCsvInput {
  /** Wire response — already enriched with totals + per-cashier rows. */
  report: CashierDayResponse;
  /** Display label rendered in the totals row's `cashier` cell. */
  totalsLabel: string;
}

export function buildCashierDayCsv(input: CashierDayCsvInput): string {
  const header = CASHIER_DAY_CSV_COLUMNS.join(CASHIER_DAY_CSV_SEPARATOR);
  const lines: string[] = [header];

  for (const row of input.report.rows) {
    lines.push(rowToLine(rowCells(row)));
  }
  lines.push(rowToLine(totalsCells(input.report.totals, input.totalsLabel)));

  return (
    CASHIER_DAY_CSV_BOM + lines.join(CASHIER_DAY_CSV_LINE_ENDING) + CASHIER_DAY_CSV_LINE_ENDING
  );
}

/**
 * Filename slug. Mirrors `eodCsvFilename` so the bookkeeper's downloads
 * folder reads as a single series: `kassa-cashier-day-{outletCodeSlug}-{businessDate}.csv`.
 */
export function cashierDayCsvFilename(outletCode: string, businessDate: string): string {
  return `kassa-cashier-day-${outletSlug(outletCode)}-${businessDate}.csv`;
}

export function outletSlug(outletCode: string): string {
  const slug = outletCode
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "outlet";
}

function rowCells(row: CashierDayResponse["rows"][number]): Record<CashierDayCsvColumn, string> {
  return {
    cashier: row.cashierName,
    sale_count: String(row.saleCount),
    gross: formatRupiahInteger(row.grossIdr),
    net: formatRupiahInteger(row.netIdr),
    void_count: String(row.voidCount),
    void_total: formatRupiahInteger(row.voidIdr),
    cash: formatRupiahInteger(tenderAmount(row.tenderMix, "cash")),
    qris_dynamic: formatRupiahInteger(tenderAmount(row.tenderMix, "qris_dynamic")),
    qris_static: formatRupiahInteger(tenderAmount(row.tenderMix, "qris_static")),
    drawer_expected:
      row.drawerExpectedIdr === null ? "" : formatRupiahInteger(row.drawerExpectedIdr),
  };
}

function totalsCells(
  totals: CashierDayResponse["totals"],
  label: string,
): Record<CashierDayCsvColumn, string> {
  return {
    cashier: label,
    sale_count: String(totals.saleCount),
    gross: formatRupiahInteger(totals.grossIdr),
    net: formatRupiahInteger(totals.netIdr),
    void_count: String(totals.voidCount),
    void_total: formatRupiahInteger(totals.voidIdr),
    cash: formatRupiahInteger(tenderAmount(totals.tenderMix, "cash")),
    qris_dynamic: formatRupiahInteger(tenderAmount(totals.tenderMix, "qris_dynamic")),
    qris_static: formatRupiahInteger(tenderAmount(totals.tenderMix, "qris_static")),
    drawer_expected:
      totals.drawerExpectedIdr === null ? "" : formatRupiahInteger(totals.drawerExpectedIdr),
  };
}

function rowToLine(cells: Record<CashierDayCsvColumn, string>): string {
  return CASHIER_DAY_CSV_COLUMNS.map((col) => escapeField(cells[col])).join(
    CASHIER_DAY_CSV_SEPARATOR,
  );
}

function tenderAmount(
  mix: readonly CashierDayResponse["rows"][number]["tenderMix"][number][],
  method: "cash" | "qris_dynamic" | "qris_static",
): number {
  return mix.find((slice) => slice.method === method)?.amountIdr ?? 0;
}

function formatRupiahInteger(amountIdr: number): string {
  return String(Math.trunc(amountIdr));
}

const NEEDS_QUOTING = /[";,\r\n]/;

function escapeField(value: string): string {
  if (!NEEDS_QUOTING.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
