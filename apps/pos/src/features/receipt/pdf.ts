/*
 * Minimal PDF 1.4 emitter for thermal-receipt fallback (KASA-309).
 *
 * Mirrors the hand-rolled escpos.ts style — no `pdf-lib` / `jspdf`
 * dependency because either adds ~60–80 KB gzip to the POS bundle and
 * the receipt is text-only on a built-in Type1 font (Courier). The
 * resulting bytes are a single-page PDF 1.4 document with one font
 * resource and one content stream; opens cleanly in iOS Safari Preview,
 * Adobe Reader, and Chromium's built-in viewer without font
 * substitution.
 *
 * WinAnsiEncoding (≈ Latin-1) is the implicit encoding for the standard
 * Courier face. We restrict the byte stream to ASCII + a few common
 * substitutions so the output is unambiguous on every viewer.
 */

import { formatIdr, toRupiah } from "../../shared/money/index.ts";
import type { Outlet, PendingSale } from "../../data/db/types.ts";
import type { ReceiptMerchant } from "./ReceiptPreview.tsx";
import { PAPER_WIDTH_CHAR_COLUMNS, type PaperWidth } from "./paperWidth.ts";

const FONT_SIZE = 9;
const LINE_HEIGHT = 11;
const MARGIN_X = 8;
const MARGIN_Y = 14;
const PAPER_WIDTH_PT: Record<PaperWidth, number> = {
  "58mm": 165,
  "80mm": 227,
};
const CHAR_WIDTH = FONT_SIZE * 0.6; // Courier is monospaced, 0.6em advance.

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function nowPdfDate(): string {
  // PDF /CreationDate format: D:YYYYMMDDHHmmSS+HH'mm'
  const d = new Date();
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const tzh = pad2(Math.floor(Math.abs(tz) / 60));
  const tzm = pad2(Math.abs(tz) % 60);
  return `D:${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}${sign}${tzh}'${tzm}'`;
}

const ASCII_SUBS: Array<[RegExp, string]> = [
  [/[—–]/g, "-"],
  [/[“”]/g, '"'],
  [/[‘’]/g, "'"],
  [/…/g, "..."],
  [/×/g, "x"],
  [/•/g, "*"],
  [/ /g, " "],
];

function toAscii(input: string): string {
  let out = input;
  for (const [pattern, replacement] of ASCII_SUBS) {
    out = out.replace(pattern, replacement);
  }
  // Fall back to '?' for any remaining non-ASCII rather than emitting a
  // malformed WinAnsi byte and tripping a font-substitution warning on
  // strict viewers.
  return out.replace(/[^\x20-\x7e]/g, "?");
}

function escapePdfString(value: string): string {
  return toAscii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function padBetween(left: string, right: string, width: number): string {
  const rightTrimmed = right.slice(0, Math.min(right.length, width - 1));
  const maxLeft = width - rightTrimmed.length - 1;
  const leftTrimmed = left.length > maxLeft ? `${left.slice(0, Math.max(0, maxLeft - 1))}…` : left;
  const gap = Math.max(1, width - leftTrimmed.length - rightTrimmed.length);
  return `${leftTrimmed}${" ".repeat(gap)}${rightTrimmed}`;
}

function formatCreatedAt(iso: string, timezone: string | null | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: timezone ?? "UTC",
      dateStyle: "short",
      timeStyle: "short",
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

export interface PdfReceiptLines {
  /** "left | right" item lines (qty + name on the left, total on the right). */
  items: ReadonlyArray<{ left: string; right: string }>;
}

export interface PdfReceiptInput {
  paperWidth: PaperWidth;
  voided: boolean;
  voidedQrisRefundNotice?: string;
  salinan?: boolean;
  voidedBannerText?: string;
  voidedReferenceText?: string;
  salinanBannerText?: string;
  outletName: string;
  outletTimezone: string | null;
  merchant?: ReceiptMerchant | null;
  npwpLabel: string;
  createdAtIso: string;
  localSaleId: string;
  itemLines: ReadonlyArray<{ left: string; right: string }>;
  subtotalLabel: string;
  subtotal: string;
  discountLabel?: string;
  discount?: string;
  taxLabel?: string;
  tax?: string;
  totalLabel: string;
  total: string;
  tenderedLabel: string;
  tendered: string;
  changeLabel: string;
  change: string;
  footerText: string;
}

interface PdfLine {
  text: string;
  align?: "left" | "center";
  bold?: boolean;
}

function buildReceiptLines(input: PdfReceiptInput): PdfLine[] {
  const width = PAPER_WIDTH_CHAR_COLUMNS[input.paperWidth];
  const lines: PdfLine[] = [];

  if (input.voided) {
    lines.push({
      text: `*** ${input.voidedBannerText ?? "PEMBATALAN"} ***`,
      align: "center",
      bold: true,
    });
    if (input.voidedReferenceText) {
      lines.push({ text: input.voidedReferenceText, align: "center" });
    }
  }
  if (input.salinan) {
    lines.push({
      text: `*** ${input.salinanBannerText ?? "SALINAN"} ***`,
      align: "center",
      bold: true,
    });
  }

  if (input.merchant) {
    lines.push({ text: input.merchant.displayName, align: "center", bold: true });
    if (input.merchant.addressLine)
      lines.push({ text: input.merchant.addressLine, align: "center" });
    if (input.merchant.phone) lines.push({ text: input.merchant.phone, align: "center" });
    if (input.merchant.npwp) {
      lines.push({ text: `${input.npwpLabel} ${input.merchant.npwp}`, align: "center" });
    }
    lines.push({ text: input.outletName, align: "center" });
  } else {
    lines.push({ text: input.outletName, align: "center", bold: true });
  }
  lines.push({ text: formatCreatedAt(input.createdAtIso, input.outletTimezone), align: "center" });
  lines.push({ text: `ID ${input.localSaleId.slice(0, 8)}`, align: "center" });
  lines.push({ text: "" });

  for (const item of input.itemLines) {
    lines.push({ text: padBetween(item.left, item.right, width) });
  }
  lines.push({ text: "-".repeat(width) });
  lines.push({ text: padBetween(input.subtotalLabel, input.subtotal, width) });
  if (input.discountLabel && input.discount) {
    lines.push({ text: padBetween(input.discountLabel, `-${input.discount}`, width) });
  }
  if (input.taxLabel && input.tax) {
    lines.push({ text: padBetween(input.taxLabel, input.tax, width) });
  }
  lines.push({ text: padBetween(input.totalLabel, input.total, width), bold: true });
  lines.push({ text: padBetween(input.tenderedLabel, input.tendered, width) });
  lines.push({ text: padBetween(input.changeLabel, input.change, width) });
  if (input.voidedQrisRefundNotice) {
    lines.push({ text: "" });
    lines.push({ text: input.voidedQrisRefundNotice, align: "center", bold: true });
  }
  lines.push({ text: "-".repeat(width) });
  lines.push({ text: input.footerText, align: "center" });

  return lines;
}

function encodeContentStream(
  lines: PdfLine[],
  pageWidth: number,
): {
  body: Uint8Array;
  pageHeight: number;
} {
  const innerWidth = pageWidth - MARGIN_X * 2;
  const lineCount = lines.length;
  const pageHeight = MARGIN_Y * 2 + lineCount * LINE_HEIGHT;

  const out: string[] = [];
  out.push("BT");
  out.push(`/F1 ${FONT_SIZE} Tf`);
  out.push(`${LINE_HEIGHT} TL`);

  // Anchor the text matrix at the top of the printable region; each
  // subsequent line moves relative to the previous one with `Td`.
  const startY = pageHeight - MARGIN_Y - FONT_SIZE;
  out.push(`1 0 0 1 ${MARGIN_X} ${startY} Tm`);

  let currentBold = false;
  let lastX = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const wantBold = Boolean(line.bold);
    if (wantBold !== currentBold) {
      out.push(`/${wantBold ? "F2" : "F1"} ${FONT_SIZE} Tf`);
      currentBold = wantBold;
    }
    const text = line.text;
    const visibleWidth = text.length * CHAR_WIDTH;
    const xOffset = line.align === "center" ? Math.max(0, (innerWidth - visibleWidth) / 2) : 0;
    if (i === 0) {
      if (xOffset !== 0) out.push(`${xOffset.toFixed(2)} 0 Td`);
    } else {
      out.push(`${(xOffset - lastX).toFixed(2)} -${LINE_HEIGHT} Td`);
    }
    lastX = xOffset;
    out.push(`(${escapePdfString(text)}) Tj`);
  }
  out.push("ET");

  const body = new TextEncoder().encode(out.join("\n"));
  return { body, pageHeight };
}

function asciiBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function encodePdfReceipt(input: PdfReceiptInput): Uint8Array {
  const lines = buildReceiptLines(input);
  const pageWidth = PAPER_WIDTH_PT[input.paperWidth];
  const { body, pageHeight } = encodeContentStream(lines, pageWidth);

  const objects: Uint8Array[] = [];

  const obj = (n: number, content: string | Uint8Array): Uint8Array => {
    const header = asciiBytes(`${n} 0 obj\n`);
    const footer = asciiBytes("\nendobj\n");
    const inner = typeof content === "string" ? asciiBytes(content) : content;
    return concatBytes([header, inner, footer]);
  };

  // 1: Catalog, 2: Pages, 3: Page, 4: Contents, 5: Font F1, 6: Font F2
  objects.push(obj(1, "<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(
    obj(2, `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 ${pageWidth} ${pageHeight}] >>`),
  );
  objects.push(
    obj(
      3,
      `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    ),
  );
  const contentHeader = asciiBytes(`<< /Length ${body.length} >>\nstream\n`);
  const contentFooter = asciiBytes("\nendstream");
  objects.push(obj(4, concatBytes([contentHeader, body, contentFooter])));
  objects.push(
    obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"),
  );
  objects.push(
    obj(6, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>"),
  );

  // Assemble file + xref.
  const header = asciiBytes("%PDF-1.4\n%\xC4\xC5\xC6\xC7\n");
  const offsets: number[] = [];
  let cursor = header.length;
  for (const o of objects) {
    offsets.push(cursor);
    cursor += o.length;
  }
  const xrefOffset = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  const info = `<< /Producer (Kassa POS) /CreationDate (${nowPdfDate()}) >>`;
  // /Info isn't strictly required; emit it as part of the trailer dict
  // to make the output friendlier in macOS Preview's metadata pane.
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return concatBytes([header, ...objects, asciiBytes(xref), asciiBytes(trailer)]);
}

/**
 * Build the receipt-render payload from a {@link PendingSale} the same way
 * `usePrintReceipt()` builds the ESC/POS payload, so the PDF output is a
 * line-for-line match of the thermal printout.
 */
export interface BuildReceiptPayloadInput {
  sale: PendingSale;
  outlet: Outlet | undefined;
  paperWidth: PaperWidth;
  merchant?: ReceiptMerchant | null;
  salinan?: boolean;
  i18n: {
    outletUnknown: string;
    npwpLabel: string;
    subtotalLabel: string;
    discountLabel: string;
    taxLabelTemplate: (rate: number) => string;
    totalLabel: string;
    tenderedLabel: string;
    changeLabel: string;
    footerThanks: string;
    salinanBanner: string;
    pembatalanBanner: string;
    pembatalanReference: string;
    pembatalanQrisRefund: string;
  };
}

export function buildPdfReceiptInput(opts: BuildReceiptPayloadInput): PdfReceiptInput {
  const { sale, outlet, paperWidth, merchant, salinan, i18n } = opts;
  const tendered = sale.tenders.reduce<number>((acc, t) => acc + (t.amountIdr as number), 0);
  const change = Math.max(0, tendered - (sale.totalIdr as number));
  const taxIdr = sale.taxIdr;
  const voided = sale.voidedAt != null;
  const qrisVoided =
    voided && sale.tenders.some((t) => t.method === "qris" || t.method === "qris_static");

  const itemLines = sale.items.map((item) => ({
    left: `${item.quantity}x ${item.itemId.slice(0, 8)}`,
    right: formatIdr(item.lineTotalIdr),
  }));

  return {
    paperWidth,
    voided,
    ...(salinan ? { salinan: true as const } : {}),
    ...(voided ? { voidedBannerText: i18n.pembatalanBanner } : {}),
    ...(voided ? { voidedReferenceText: i18n.pembatalanReference } : {}),
    ...(qrisVoided ? { voidedQrisRefundNotice: i18n.pembatalanQrisRefund } : {}),
    ...(salinan ? { salinanBannerText: i18n.salinanBanner } : {}),
    outletName: outlet?.name ?? i18n.outletUnknown,
    outletTimezone: outlet?.timezone ?? null,
    merchant: merchant ?? null,
    npwpLabel: i18n.npwpLabel,
    createdAtIso: sale.createdAt,
    localSaleId: sale.localSaleId,
    itemLines,
    subtotalLabel: i18n.subtotalLabel,
    subtotal: formatIdr(sale.subtotalIdr),
    ...((sale.discountIdr as number) > 0
      ? { discountLabel: i18n.discountLabel, discount: formatIdr(sale.discountIdr) }
      : {}),
    ...(taxIdr !== undefined && (taxIdr as number) > 0
      ? { taxLabel: i18n.taxLabelTemplate(11), tax: formatIdr(taxIdr) }
      : {}),
    totalLabel: i18n.totalLabel,
    total: formatIdr(sale.totalIdr),
    tenderedLabel: i18n.tenderedLabel,
    tendered: formatIdr(toRupiah(tendered)),
    changeLabel: i18n.changeLabel,
    change: formatIdr(toRupiah(change)),
    footerText: merchant?.receiptFooterText?.trim() || i18n.footerThanks,
  };
}

/**
 * Compose the receipt download filename. Falls back to the local sale id
 * when the server hasn't returned a canonical name yet (e.g. the device
 * is still offline at receipt time).
 */
export function pdfReceiptFilename(sale: PendingSale): string {
  const saleNumber = sale.serverSaleName?.trim() || sale.localSaleId.slice(0, 8);
  const safe = saleNumber.replace(/[^A-Za-z0-9_-]+/g, "-");
  const outletSlug = sale.outletId.slice(0, 8);
  return `kassa-${outletSlug}-${safe}.pdf`;
}
