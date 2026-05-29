/*
 * Minimal ESC/POS encoder. Covers the commands the v0 receipt layout needs:
 * initialise, align, bold, text line, line feed, paper cut. Encoded as a
 * single Uint8Array we stream in ≤512 B chunks to the GATT characteristic
 * (BLE payload ceiling on most Android Web Bluetooth stacks).
 *
 * Receipt bytes are ASCII — the printer's default CP437 code page is enough
 * for Rupiah totals and Indonesian item names transliterated by the clerk.
 * Non-ASCII falls back to `?` rather than throwing.
 */

export type Alignment = "left" | "center" | "right";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

function ascii(input: string): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    out[i] = code <= 0x7f ? code : 0x3f; // "?"
  }
  return out;
}

function align(value: Alignment): number {
  switch (value) {
    case "center":
      return 0x01;
    case "right":
      return 0x02;
    default:
      return 0x00;
  }
}

export class EscPosBuilder {
  private chunks: number[] = [];

  init(): this {
    this.chunks.push(ESC, 0x40); // ESC @
    return this;
  }

  align(value: Alignment): this {
    this.chunks.push(ESC, 0x61, align(value)); // ESC a n
    return this;
  }

  bold(on: boolean): this {
    this.chunks.push(ESC, 0x45, on ? 0x01 : 0x00); // ESC E n
    return this;
  }

  text(line: string): this {
    const bytes = ascii(line);
    for (let i = 0; i < bytes.length; i += 1) this.chunks.push(bytes[i] ?? 0);
    return this;
  }

  lineFeed(count = 1): this {
    for (let i = 0; i < count; i += 1) this.chunks.push(LF);
    return this;
  }

  line(value = ""): this {
    return this.text(value).lineFeed(1);
  }

  cut(partial = true): this {
    this.chunks.push(GS, 0x56, partial ? 0x01 : 0x00); // GS V n
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export interface ReceiptLine {
  left: string;
  right: string;
}

/**
 * Merchant-wide receipt branding (KASA-219). Optional — when absent the
 * receipt falls back to outlet-name-only header and the i18n thanks
 * footer. The `npwpLabel` is supplied by the caller so the wire payload
 * stays locale-agnostic (the i18n catalogue owns the user-facing string).
 */
export interface ReceiptMerchant {
  displayName: string;
  addressLine: string | null;
  phone: string | null;
  npwp: string | null;
  npwpLabel: string;
  receiptFooterText: string | null;
}

/**
 * KASA-367 — per-outlet receipt branding overrides. Optional; when
 * present, fields override the merchant-wide block above for this
 * outlet's receipt. Empty fields render no blank line.
 *
 *  - `displayName` overrides the merchant's `displayName` as the bold
 *    header. If null/empty, the merchant header (or `outletName`) is
 *    used unchanged.
 *  - `addressLine1` / `addressLine2` print one per line under the
 *    display name. They replace the merchant's `addressLine` when at
 *    least one is set; otherwise the merchant address falls through.
 *  - `taxId` is the bare NPWP digits (15 or 16). The encoder formats
 *    15-digit values with the canonical `00.000.000.0-000.000` mask
 *    and the 16-digit NIK-NPWP as `0000 0000 0000 0000`.
 *  - `footerLine1` / `footerLine2` are the customer-facing footer the
 *    owner wants printed above the cut. When at least one is set they
 *    replace the merchant footer; the i18n `footerThanks` is only used
 *    when neither outlet nor merchant supplies one.
 */
export interface ReceiptOutletBranding {
  displayName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  taxId: string | null;
  footerLine1: string | null;
  footerLine2: string | null;
}

/**
 * Format a bare NPWP for the receipt header. 15-digit NPWP uses the
 * canonical `00.000.000.0-000.000` mask; 16-digit NIK-NPWP (DJP 2024)
 * prints as four 4-digit groups separated by spaces. Falls back to the
 * raw input when the shape is unexpected so a stray digit count still
 * prints something rather than nothing.
 */
export function formatTaxIdForReceipt(taxId: string): string {
  const digits = taxId.replace(/\D+/g, "");
  if (digits.length === 15) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}.${digits.slice(
      8,
      9,
    )}-${digits.slice(9, 12)}.${digits.slice(12, 15)}`;
  }
  if (digits.length === 16) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)} ${digits.slice(12, 16)}`;
  }
  return taxId;
}

export interface ReceiptPayload {
  outletName: string;
  outletTimezone?: string | null;
  /**
   * Deprecated alias kept so older call sites compile. Prefer
   * `merchant.addressLine`. Ignored when `merchant` is set.
   */
  address?: string | null;
  /** Merchant brand block printed at the top of the receipt (KASA-219). */
  merchant?: ReceiptMerchant | null;
  /**
   * KASA-367 — per-outlet override block. Wins over `merchant` fields
   * when the corresponding override is non-null/non-empty.
   */
  outletBranding?: ReceiptOutletBranding | null;
  /** Locale-owned NPWP label (e.g. "NPWP"). Required when `outletBranding.taxId` is set. */
  npwpLabel?: string;
  createdAtIso: string;
  localSaleId: string;
  items: readonly ReceiptLine[];
  subtotal: string;
  discount: string;
  /**
   * KASA-218 — Indonesian PPN line. Optional so legacy callers that haven't
   * been bumped still encode without a tax row. When set, both `taxLabel`
   * and `tax` must be provided; the encoder renders one row between
   * `Diskon` and `Total`.
   */
  taxLabel?: string;
  tax?: string;
  total: string;
  tenderedLabel: string;
  tendered: string;
  changeLabel: string;
  change: string;
  footerThanks: string;
  width: 32 | 42;
  /**
   * When true, prepend a bold "SALINAN" (Copy) banner above the outlet name so
   * the printed copy is unambiguously distinguishable from the original. Set
   * by the reprint flow (KASA-220) — reprints must never read like fresh sales
   * because audit/EOD reconciliation runs off the original.
   */
  salinan?: boolean;
}

function padBetween(left: string, right: string, width: number): string {
  // Trim the left side if the combined length overflows; prefer keeping the
  // amount visible on the right.
  const rightTrimmed = right.slice(0, Math.min(right.length, width - 1));
  const maxLeft = width - rightTrimmed.length - 1;
  const leftTrimmed = left.length > maxLeft ? `${left.slice(0, Math.max(0, maxLeft - 1))}…` : left;
  const gap = Math.max(1, width - leftTrimmed.length - rightTrimmed.length);
  return `${leftTrimmed}${" ".repeat(gap)}${rightTrimmed}`;
}

function centerLine(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  const pad = Math.floor((width - value.length) / 2);
  return `${" ".repeat(pad)}${value}`;
}

function formatCreatedAt(iso: string, timezone: string | null | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    const fmt = new Intl.DateTimeFormat("id-ID", {
      timeZone: timezone ?? "UTC",
      dateStyle: "short",
      timeStyle: "short",
    });
    return fmt.format(d);
  } catch {
    return d.toISOString();
  }
}

export function encodeReceipt(payload: ReceiptPayload): Uint8Array {
  const width = payload.width;
  const b = new EscPosBuilder().init();

  // KASA-367 — resolve the effective header block. Outlet overrides win
  // per-field over merchant fields; either or both falling through
  // preserves the existing layout for outlets without overrides.
  const branding = payload.outletBranding ?? null;
  const merchant = payload.merchant ?? null;
  const headerName = nonEmpty(branding?.displayName) ?? merchant?.displayName ?? null;
  const outletAddressLines = collectAddressLines(branding);
  const merchantAddressLine = merchant?.addressLine ?? null;
  const addressLines =
    outletAddressLines.length > 0
      ? outletAddressLines
      : merchantAddressLine
        ? [merchantAddressLine]
        : [];
  const phone = merchant?.phone ?? null;
  const outletTaxId = nonEmpty(branding?.taxId);
  const npwpLabel = payload.npwpLabel ?? merchant?.npwpLabel ?? "NPWP";
  // KASA-367 — only outlet-level NPWP is reformatted with the canonical
  // mask. Merchant-level `npwp` (KASA-219) is printed as-supplied so
  // pre-KASA-367 receipts stay byte-identical.
  const taxIdDisplay = outletTaxId ? formatTaxIdForReceipt(outletTaxId) : (merchant?.npwp ?? null);

  b.align("center");
  if (payload.salinan) {
    b.bold(true).line("*** SALINAN ***").bold(false);
  }
  if (headerName) {
    b.bold(true).line(headerName).bold(false);
    for (const line of addressLines) b.line(line);
    if (phone) b.line(phone);
    if (taxIdDisplay) b.line(`${npwpLabel} ${taxIdDisplay}`);
    // Print the outlet name as a sub-line only when it differs from the
    // bold display name; otherwise duplicating it adds a blank-looking row.
    if (payload.outletName && payload.outletName !== headerName) {
      b.line(payload.outletName);
    }
  } else {
    b.bold(true).line(payload.outletName).bold(false);
    for (const line of addressLines) b.line(line);
    if (taxIdDisplay) b.line(`${npwpLabel} ${taxIdDisplay}`);
    if (!addressLines.length && payload.address) b.line(payload.address);
  }
  b.line(formatCreatedAt(payload.createdAtIso, payload.outletTimezone ?? null));
  b.line(`ID ${payload.localSaleId.slice(0, 8)}`);
  b.line("");

  b.align("left");
  for (const line of payload.items) {
    b.line(padBetween(line.left, line.right, width));
  }
  b.line("-".repeat(width));
  b.line(padBetween("Subtotal", payload.subtotal, width));
  if (payload.discount && payload.discount !== payload.subtotal) {
    b.line(padBetween("Diskon", `-${payload.discount}`, width));
  }
  if (payload.taxLabel && payload.tax) {
    // KASA-218 — between discount and total. The "PPN sudah termasuk"
    // convention for inclusive merchants is conveyed by the label
    // localisation; the encoder doesn't decide inclusive vs exclusive.
    b.line(padBetween(payload.taxLabel, payload.tax, width));
  }
  b.bold(true)
    .line(padBetween("Total", payload.total, width))
    .bold(false);
  b.line(padBetween(payload.tenderedLabel, payload.tendered, width));
  b.line(padBetween(payload.changeLabel, payload.change, width));
  b.line("");

  // KASA-367 — outlet footer overrides the merchant footer; merchant footer
  // overrides the locale fallback. An outlet may set either or both lines;
  // both append in order. Empty lines are skipped so receipts render
  // unchanged when no overrides are set.
  const outletFooterLines = collectFooterLines(branding);
  if (outletFooterLines.length > 0) {
    b.align("center");
    for (const line of outletFooterLines) b.line(line);
  } else {
    b.align("center").line(merchant?.receiptFooterText || payload.footerThanks);
  }
  b.lineFeed(3);
  b.cut(true);
  return b.build();
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function collectAddressLines(branding: ReceiptOutletBranding | null): string[] {
  if (!branding) return [];
  const lines: string[] = [];
  const a = nonEmpty(branding.addressLine1);
  const b = nonEmpty(branding.addressLine2);
  if (a) lines.push(a);
  if (b) lines.push(b);
  return lines;
}

function collectFooterLines(branding: ReceiptOutletBranding | null): string[] {
  if (!branding) return [];
  const lines: string[] = [];
  const a = nonEmpty(branding.footerLine1);
  const b = nonEmpty(branding.footerLine2);
  if (a) lines.push(a);
  if (b) lines.push(b);
  return lines;
}

export function centerLineForWidth(value: string, width: 32 | 42): string {
  return centerLine(value, width);
}

export function padBetweenForWidth(left: string, right: string, width: 32 | 42): string {
  return padBetween(left, right, width);
}
