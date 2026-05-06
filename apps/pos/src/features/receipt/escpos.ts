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

export interface ReceiptPayload {
  outletName: string;
  outletTimezone?: string | null;
  address?: string | null;
  createdAtIso: string;
  localSaleId: string;
  items: readonly ReceiptLine[];
  subtotal: string;
  discount: string;
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

  if (payload.salinan) {
    b.align("center").bold(true).line("*** SALINAN ***").bold(false);
  }
  b.align("center").bold(true).line(payload.outletName).bold(false);
  if (payload.address) b.line(payload.address);
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
  b.bold(true)
    .line(padBetween("Total", payload.total, width))
    .bold(false);
  b.line(padBetween(payload.tenderedLabel, payload.tendered, width));
  b.line(padBetween(payload.changeLabel, payload.change, width));
  b.line("");

  b.align("center").line(payload.footerThanks);
  b.lineFeed(3);
  b.cut(true);
  return b.build();
}

export function centerLineForWidth(value: string, width: 32 | 42): string {
  return centerLine(value, width);
}

export function padBetweenForWidth(left: string, right: string, width: 32 | 42): string {
  return padBetween(left, right, width);
}
