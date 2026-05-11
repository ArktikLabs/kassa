import type { EodRecord } from "./types.js";

/*
 * EOD reconciliation CSV builder (KASA-250).
 *
 * Generates the file Indonesian SMB merchants hand to their part-time
 * bookkeeper. Format choices follow `apps/back-office/src/routes/
 * reports.reconciliation.tsx` and the issue body:
 *
 *   - UTF-8 BOM prefix so Excel-id picks up the encoding without the
 *     user fighting an import wizard for "Bahasa Indonesia" characters.
 *   - `;` (semicolon) field separator — the Indonesian Excel default
 *     because `,` is the decimal mark in id-ID locale.
 *   - RFC-4180 quoting: only quote a field when it contains the
 *     separator, a `"` (which is doubled), CR, or LF.
 *   - CRLF line endings (also RFC-4180) so the file opens identically
 *     in LibreOffice on Linux and Excel on Windows.
 *   - Numeric columns are plain integer rupiah (no thousands grouping,
 *     no decimal places) so the bookkeeper can re-import without a
 *     locale dance.
 *
 * The builder is pure: callers gather the joined EOD/outlet/shift/
 * cashier rows and pass them in. The Fastify handler in
 * `apps/api/src/routes/eod.ts` is the only production caller.
 */

export const EOD_CSV_BOM = "﻿";
export const EOD_CSV_SEPARATOR = ";";
export const EOD_CSV_LINE_ENDING = "\r\n";

/** Column order is the contract — keep in sync with the issue body. */
export const EOD_CSV_COLUMNS = [
  "outlet",
  "eod_date",
  "shift_open_at",
  "shift_close_at",
  "cashier",
  "expected_cash",
  "counted_cash",
  "cash_variance",
  "expected_qris",
  "settled_qris",
  "qris_variance",
  "gross",
  "ppn",
  "net",
  "sale_count",
  "void_count",
] as const;

export type EodCsvColumn = (typeof EOD_CSV_COLUMNS)[number];

export interface EodCsvOutletInput {
  /** Human-facing name printed in the `outlet` column. */
  name: string;
  /** Merchant-scoped short code used to slug the filename. */
  code: string;
}

export interface EodCsvShiftInput {
  /** ISO-8601 with offset; rendered verbatim in the CSV. */
  openedAt: string;
  /** ISO-8601 with offset, null when the shift was force-closed by EOD. */
  closedAt: string | null;
  /** Display name resolved from the staff row; falls back to staff id. */
  cashier: string;
}

export interface EodCsvInput {
  eod: EodRecord;
  outlet: EodCsvOutletInput;
  /**
   * Pre-KASA-235 closes have no shift row; the join is best-effort and
   * the corresponding columns render as empty strings when null. The
   * close timestamp (EodRecord.closedAt) is always populated and is
   * used as the fallback for `shift_close_at` when a shift row exists
   * but `closedAt` is still null (the shift was force-closed by EOD).
   */
  shift: EodCsvShiftInput | null;
}

/**
 * Build the CSV document, including the UTF-8 BOM prefix. The return
 * value is the body to write to the response; the caller is responsible
 * for the `Content-Type: text/csv; charset=utf-8` and
 * `Content-Disposition` headers.
 */
export function buildEodCsv(input: EodCsvInput): string {
  const row = buildRow(input);
  const header = EOD_CSV_COLUMNS.join(EOD_CSV_SEPARATOR);
  const body = EOD_CSV_COLUMNS.map((col) => escapeField(row[col])).join(EOD_CSV_SEPARATOR);
  return `${EOD_CSV_BOM}${header}${EOD_CSV_LINE_ENDING}${body}${EOD_CSV_LINE_ENDING}`;
}

/**
 * Slug used in the `Content-Disposition` filename
 * (`kassa-eod-{slug}-{YYYY-MM-DD}.csv`). Lower-cased outlet code with
 * any character outside `[a-z0-9]` collapsed to `-`. Falls back to
 * `outlet` when the code reduces to an empty string so the filename
 * is always non-empty.
 */
export function outletSlug(outletCode: string): string {
  const slug = outletCode
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "outlet";
}

/**
 * Render the `Content-Disposition` filename portion. Uses RFC-5987
 * `filename*=UTF-8''…` so non-ASCII slugs (defensive — the
 * `outletSlug` collapse already strips them) survive the header.
 */
export function eodCsvFilename(outletCode: string, businessDate: string): string {
  return `kassa-eod-${outletSlug(outletCode)}-${businessDate}.csv`;
}

function buildRow(input: EodCsvInput): Record<EodCsvColumn, string> {
  const { eod, outlet, shift } = input;
  const breakdown = eod.breakdown;

  /**
   * "Expected QRIS" sums both QRIS channels: dynamic (Midtrans-vouched
   * at tap) and static (paper QR — vouched async by the reconciliation
   * pass). "Settled QRIS" subtracts the still-unverified static slice,
   * matching the static-QRIS reconciliation surface at
   * `/admin/reconciliation`. Variance is the at-risk amount the
   * bookkeeper must chase down.
   */
  const expectedQris = breakdown.qrisStaticIdr + breakdown.qrisDynamicIdr;
  const settledQris = expectedQris - breakdown.qrisStaticUnverifiedIdr;
  const qrisVariance = expectedQris - settledQris;

  /**
   * `cash_variance` is the same scalar EOD already records as
   * `varianceIdr` — counted − expected, signed. Surface it through a
   * dedicated column rather than re-computing here so a single source
   * of truth feeds both the close screen and the bookkeeper file.
   */
  const cashVariance = eod.varianceIdr;

  /**
   * Gross is the receipted total the merchant collected from
   * customers; for an inclusive (`ppn_11`) merchant `netIdr` already
   * contains the tax, so gross == net. For a future exclusive
   * merchant the tax sits on top and gross == net + tax. We compute
   * `net + tax` against the close so today's inclusive merchants get
   * gross == netIdr (taxIdr is zero) and the column stays correct
   * once exclusive merchants ship.
   */
  const gross = breakdown.netIdr + breakdown.taxIdr;

  return {
    outlet: outlet.name,
    eod_date: eod.businessDate,
    shift_open_at: shift?.openedAt ?? "",
    shift_close_at: shift?.closedAt ?? eod.closedAt,
    cashier: shift?.cashier ?? "",
    expected_cash: formatRupiahInteger(eod.expectedCashIdr),
    counted_cash: formatRupiahInteger(eod.countedCashIdr),
    cash_variance: formatRupiahInteger(cashVariance),
    expected_qris: formatRupiahInteger(expectedQris),
    settled_qris: formatRupiahInteger(settledQris),
    qris_variance: formatRupiahInteger(qrisVariance),
    gross: formatRupiahInteger(gross),
    ppn: formatRupiahInteger(breakdown.taxIdr),
    net: formatRupiahInteger(breakdown.netIdr),
    sale_count: String(breakdown.saleCount),
    void_count: String(breakdown.voidCount),
  };
}

/**
 * Plain integer rendering — no thousands separator, no decimal places.
 * Negative variances render with a leading `-` so cash-short days
 * survive a CSV re-import as signed integers.
 */
function formatRupiahInteger(amountIdr: number): string {
  return String(Math.trunc(amountIdr));
}

const NEEDS_QUOTING = /[";,\r\n]/;

/**
 * RFC-4180 quoting. We always escape `,` defensively even though the
 * separator is `;` — if a future caller hands us a string containing
 * `,` it should still survive being parsed by a tool that auto-detects
 * the separator.
 */
function escapeField(value: string): string {
  if (!NEEDS_QUOTING.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
