import { formatIdr, toRupiah } from "../../shared/money/index.ts";
import type { Outlet, PendingSale, PendingSaleTenderMethod } from "../../data/db/types.ts";
import type { ReceiptMerchant } from "./ReceiptPreview.tsx";

/*
 * Plain-text builder for the "Kirim WhatsApp" share flow (KASA-252).
 *
 * Mirrors the printed receipt layout (see `printing.ts` / `escpos.ts`) so the
 * customer sees the same fields whether the cashier prints or shares. Output
 * is Bahasa Indonesia by default through `formatMessage`; the body is plain
 * text (no Markdown, no emoji) because WhatsApp renders raw text best and the
 * brand voice for receipts is neutral.
 */

export interface ShareBodyInput {
  sale: PendingSale;
  outlet: Outlet | undefined;
  merchant?: ReceiptMerchant | null | undefined;
  formatMessage: FormatMessage;
}

type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

const TENDER_METHOD_KEY: Record<PendingSaleTenderMethod, string> = {
  cash: "receipt.history.row.tender.cash",
  qris: "receipt.history.row.tender.qris",
  qris_static: "receipt.history.row.tender.qris_static",
  card: "receipt.history.row.tender.card",
  other: "receipt.history.row.tender.other",
};

function formatDateTime(iso: string, timezone: string | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: timezone ?? "UTC",
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function tenderMethodLabel(sale: PendingSale, formatMessage: FormatMessage): string {
  const methods = new Set(sale.tenders.map((t) => t.method));
  if (methods.size === 0) return formatMessage({ id: "receipt.history.row.tender.other" });
  if (methods.size > 1) return formatMessage({ id: "receipt.history.row.tender.mixed" });
  const [only] = methods;
  return formatMessage({ id: TENDER_METHOD_KEY[only as PendingSaleTenderMethod] });
}

export function buildWhatsAppReceiptBody({
  sale,
  outlet,
  merchant,
  formatMessage,
}: ShareBodyInput): string {
  const headerLines: string[] = [];
  if (merchant) {
    headerLines.push(merchant.displayName);
    if (merchant.addressLine) headerLines.push(merchant.addressLine);
    if (merchant.phone) headerLines.push(merchant.phone);
    if (merchant.npwp) {
      headerLines.push(`${formatMessage({ id: "receipt.merchant.npwp" })} ${merchant.npwp}`);
    }
  }
  const outletName = outlet?.name ?? formatMessage({ id: "receipt.outlet.unknown" });
  headerLines.push(outletName);
  headerLines.push(formatDateTime(sale.createdAt, outlet?.timezone));
  headerLines.push(`ID ${sale.localSaleId.slice(0, 8)}`);

  const itemLines = sale.items.map((item) => {
    return `${item.quantity}x ${item.itemId.slice(0, 8)}  ${formatIdr(item.lineTotalIdr)}`;
  });

  const totalsLines: string[] = [];
  totalsLines.push(
    `${formatMessage({ id: "receipt.subtotal" })}: ${formatIdr(sale.subtotalIdr)}`,
  );
  if ((sale.discountIdr as number) > 0) {
    totalsLines.push(
      `${formatMessage({ id: "receipt.discount" })}: -${formatIdr(sale.discountIdr)}`,
    );
  }
  if (sale.taxIdr !== undefined && (sale.taxIdr as number) > 0) {
    totalsLines.push(
      `${formatMessage({ id: "receipt.tax" }, { rate: 11 })}: ${formatIdr(sale.taxIdr)}`,
    );
  }
  totalsLines.push(`${formatMessage({ id: "receipt.total" })}: ${formatIdr(sale.totalIdr)}`);

  const tendered = sale.tenders.reduce<number>(
    (acc, t) => acc + (t.amountIdr as number),
    0,
  );
  const change = Math.max(0, tendered - (sale.totalIdr as number));
  totalsLines.push(
    `${formatMessage({ id: "receipt.tendered" })}: ${formatIdr(toRupiah(tendered))}`,
  );
  totalsLines.push(
    `${formatMessage({ id: "receipt.change" })}: ${formatIdr(toRupiah(change))}`,
  );
  totalsLines.push(
    formatMessage(
      { id: "receipt.share.body.tenderMethod" },
      { method: tenderMethodLabel(sale, formatMessage) },
    ),
  );

  const footer = merchant?.receiptFooterText?.trim() || formatMessage({ id: "receipt.footer.thanks" });

  const separator = "------------------------------";
  return [
    ...headerLines,
    separator,
    ...itemLines,
    separator,
    ...totalsLines,
    separator,
    footer,
  ].join("\n");
}

const WA_DEEP_LINK_BASE = "https://wa.me/?text=";

export function buildWhatsAppShareUrl(body: string): string {
  return `${WA_DEEP_LINK_BASE}${encodeURIComponent(body)}`;
}
