import type { SalesSummaryResponse } from "@kassa/schemas/salesSummary";

/*
 * Pure helpers behind the back-office "Ringkasan periode" exports (KASA-327).
 *
 * Pulled out of the React component so the CSV formatting is unit-testable
 * without a DOM, and so the printable HTML stays trivial to inspect when
 * the merchant's accountant inevitably asks "what's this PDF showing me?".
 */

export interface SalesSummaryCsvInput {
  summary: SalesSummaryResponse;
  /** Localised label for `groupBy` — used in the header comment row. */
  groupByLabel: string;
  headerLabels: {
    key: string;
    label: string;
    gross: string;
    discount: string;
    tax: string;
    net: string;
    saleCount: string;
    refundCount: string;
    refundIdr: string;
    quantity: string;
  };
}

/**
 * Serialise the summary into a CSV the merchant's accountant can drop into
 * Excel / Sheets. One row per `groupBy` bucket plus a leading "Periode"
 * comment line. Numbers are written as raw integers (no thousands separator)
 * so the spreadsheet parses each cell as a number rather than a label —
 * "Rp 12.500" would otherwise come through as text and break SUM().
 */
export function buildSalesSummaryCsv(input: SalesSummaryCsvInput): string {
  const { summary, groupByLabel, headerLabels } = input;
  const lines: string[] = [];
  // BOM so Excel on Windows opens UTF-8 without mojibake.
  const bom = "﻿";
  lines.push(
    `# Periode: ${summary.from} → ${summary.to} · ${groupByLabel} · outlet: ${summary.outletId ?? "semua"}`,
  );
  const columns =
    summary.groupBy === "item"
      ? [headerLabels.key, headerLabels.label, headerLabels.gross, headerLabels.quantity]
      : [
          headerLabels.key,
          headerLabels.label,
          headerLabels.gross,
          headerLabels.discount,
          headerLabels.tax,
          headerLabels.net,
          headerLabels.saleCount,
          headerLabels.refundCount,
          headerLabels.refundIdr,
        ];
  lines.push(columns.map(csvCell).join(","));
  for (const row of summary.groups) {
    const cells =
      summary.groupBy === "item"
        ? [row.key, row.label, String(row.grossIdr), String(row.quantity)]
        : [
            row.key,
            row.label,
            String(row.grossIdr),
            String(row.discountIdr),
            String(row.taxIdr),
            String(row.netIdr),
            String(row.saleCount),
            String(row.refundCount),
            String(row.refundIdr),
          ];
    lines.push(cells.map(csvCell).join(","));
  }
  return `${bom}${lines.join("\r\n")}\r\n`;
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export interface SalesSummaryPrintInput {
  summary: SalesSummaryResponse;
  headingLabel: string;
  groupByLabel: string;
  groupByColumnLabel: string;
  tenderLabelsByMethod: Record<"cash" | "qris_dynamic" | "qris_static", string>;
  labels: {
    gross: string;
    discount: string;
    tax: string;
    net: string;
    saleCount: string;
    refundCount: string;
    refundIdr: string;
    tenderMix: string;
    topItems: string;
    breakdown: string;
    rangeFooter: string;
  };
}

/**
 * Opens a new window with a print-only summary report and immediately
 * triggers the browser's print dialog. Reuses the system "Save as PDF"
 * handler — every major browser exposes one — so we don't pull a heavy
 * client-side PDF library into the back-office bundle for a once-a-month
 * action. KASA-309's custom encoder stays scoped to the receipt path
 * (tight column widths + ESC/POS parity); the bookkeeping report is a
 * normal HTML table.
 *
 * Returns the window reference for tests; the seam lets us inject a stub
 * that captures the rendered HTML without spawning a real popup.
 */
export function openSalesSummaryPrintWindow(
  input: SalesSummaryPrintInput,
  opts: {
    open?: (url: string, target: string, features?: string) => Window | null;
  } = {},
): Window | null {
  const opener = opts.open ?? ((url, target, features) => window.open(url, target, features));
  const win = opener("", "_blank", "noopener,width=900,height=1100");
  if (!win) return null;
  win.document.open();
  win.document.write(renderSalesSummaryPrintHtml(input));
  win.document.close();
  // Print after the document has settled — synchronous `win.print()` racing
  // against `document.close()` can no-op on Firefox.
  win.setTimeout(() => {
    win.focus();
    win.print();
  }, 100);
  return win;
}

/** Exported for unit tests; returns the rendered HTML string. */
export function renderSalesSummaryPrintHtml(input: SalesSummaryPrintInput): string {
  const { summary, headingLabel, groupByLabel, groupByColumnLabel, labels, tenderLabelsByMethod } =
    input;
  const idrFormatter = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  });
  const fmt = (n: number) => idrFormatter.format(n);

  const breakdownColumns =
    summary.groupBy === "item"
      ? [groupByColumnLabel, labels.gross, "Qty"]
      : [
          groupByColumnLabel,
          labels.gross,
          labels.discount,
          labels.tax,
          labels.net,
          labels.saleCount,
          labels.refundIdr,
        ];
  const breakdownRows = summary.groups
    .map((row) => {
      const cells =
        summary.groupBy === "item"
          ? [escapeHtml(row.label || row.key), fmt(row.grossIdr), String(row.quantity)]
          : [
              escapeHtml(row.label || row.key),
              fmt(row.grossIdr),
              fmt(row.discountIdr),
              fmt(row.taxIdr),
              fmt(row.netIdr),
              String(row.saleCount),
              fmt(row.refundIdr),
            ];
      return `<tr>${cells.map((c, i) => `<td${i === 0 ? "" : ' class="num"'}>${c}</td>`).join("")}</tr>`;
    })
    .join("");

  const tenderRows = summary.tenderMix
    .map(
      (slice) =>
        `<tr><td>${escapeHtml(tenderLabelsByMethod[slice.method])}</td><td class="num">${fmt(slice.amountIdr)}</td></tr>`,
    )
    .join("");

  const topItemRows = summary.topItemsByRevenue
    .map(
      (row, index) =>
        `<tr><td>${index + 1}. ${escapeHtml(row.name)}</td><td class="num">${fmt(row.revenueIdr)}</td></tr>`,
    )
    .join("");

  // Inline styles only — the print window has no access to the SPA bundle's
  // Tailwind output. The "@page" + "@media print" rules keep the report on
  // one A4 page when the totals + breakdown rows are short, with the
  // breakdown wrapping if it overflows.
  return `<!doctype html>
<html lang="id-ID">
<head>
<meta charset="utf-8">
<title>${escapeHtml(headingLabel)} ${escapeHtml(summary.from)} – ${escapeHtml(summary.to)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; color: #111827; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #4b5563; font-size: 13px; margin: 0 0 16px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; margin: 18px 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #e5e7eb; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 12px 0; }
  .totals .tile { border: 1px solid #e5e7eb; padding: 10px; border-radius: 6px; }
  .totals .label { font-size: 10px; text-transform: uppercase; color: #6b7280; }
  .totals .value { font-size: 16px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
  footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #6b7280; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <h1>${escapeHtml(headingLabel)}</h1>
  <p class="sub">${escapeHtml(summary.from)} → ${escapeHtml(summary.to)} · ${escapeHtml(groupByLabel)}</p>

  <div class="totals">
    <div class="tile"><div class="label">${escapeHtml(labels.gross)}</div><div class="value">${fmt(summary.grossIdr)}</div></div>
    <div class="tile"><div class="label">${escapeHtml(labels.discount)}</div><div class="value">${fmt(summary.discountIdr)}</div></div>
    <div class="tile"><div class="label">${escapeHtml(labels.tax)}</div><div class="value">${fmt(summary.taxIdr)}</div></div>
    <div class="tile"><div class="label">${escapeHtml(labels.net)}</div><div class="value">${fmt(summary.netIdr)}</div></div>
    <div class="tile"><div class="label">${escapeHtml(labels.saleCount)}</div><div class="value">${summary.saleCount}</div></div>
    <div class="tile"><div class="label">${escapeHtml(labels.refundCount)}</div><div class="value">${summary.refundCount}</div></div>
    <div class="tile"><div class="label">${escapeHtml(labels.refundIdr)}</div><div class="value">${fmt(summary.refundIdr)}</div></div>
  </div>

  ${tenderRows ? `<h2>${escapeHtml(labels.tenderMix)}</h2><table><tbody>${tenderRows}</tbody></table>` : ""}

  <h2>${escapeHtml(labels.breakdown)}</h2>
  <table>
    <thead><tr>${breakdownColumns.map((c, i) => `<th${i === 0 ? "" : ' class="num"'}>${escapeHtml(c)}</th>`).join("")}</tr></thead>
    <tbody>${breakdownRows}</tbody>
  </table>

  ${topItemRows ? `<h2>${escapeHtml(labels.topItems)}</h2><table><tbody>${topItemRows}</tbody></table>` : ""}

  <footer>${escapeHtml(labels.rangeFooter)}</footer>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
