import { useIntl } from "react-intl";
import { formatIdr, type Rupiah } from "../../shared/money/index.ts";
import type { Outlet, PendingSale } from "../../data/db/types.ts";
import { PAPER_WIDTH_PX, type PaperWidth } from "./paperWidth.ts";

/**
 * Merchant-wide receipt branding (KASA-219). Optional — falls back to
 * outlet name + i18n thanks footer when absent.
 */
export interface ReceiptMerchant {
  displayName: string;
  addressLine: string | null;
  phone: string | null;
  npwp: string | null;
  receiptFooterText: string | null;
}

interface ReceiptPreviewProps {
  sale: PendingSale;
  outlet: Outlet | undefined;
  paperWidth: PaperWidth;
  merchant?: ReceiptMerchant | null;
  /**
   * When true, render the on-screen preview with a "SALINAN" (Copy) banner so
   * the clerk can confirm a reprint will be unambiguous before tapping Cetak
   * Ulang. Mirrors the ESC/POS `salinan` flag (KASA-220).
   */
  salinan?: boolean;
}

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

export function ReceiptPreview({
  sale,
  outlet,
  paperWidth,
  merchant,
  salinan,
}: ReceiptPreviewProps) {
  const intl = useIntl();
  const widthPx = PAPER_WIDTH_PX[paperWidth];
  const totalTendered = sale.tenders.reduce<number>(
    (acc, t) => acc + (t.amountIdr as number),
    0,
  ) as Rupiah;
  const change = Math.max(0, (totalTendered as number) - (sale.totalIdr as number)) as Rupiah;
  const npwpLabel = intl.formatMessage({ id: "receipt.merchant.npwp" });
  const fallbackFooter = intl.formatMessage({ id: "receipt.footer.thanks" });
  const footerText = merchant?.receiptFooterText?.trim() || fallbackFooter;
  const voided = sale.voidedAt != null;
  // KASA-236-B — voided sales whose money landed via QRIS need a refund
  // line in the printed copy: QRIS funds are off-device, so the cashier
  // must hand cash back manually. Static QRIS (KASA-64) settles the same
  // way for our purposes, so we trigger on both.
  const qrisVoided =
    voided && sale.tenders.some((t) => t.method === "qris" || t.method === "qris_static");

  return (
    <article
      data-testid="receipt-preview"
      data-paper-width={paperWidth}
      data-salinan={salinan ? "true" : undefined}
      data-voided={voided ? "true" : undefined}
      className="mx-auto rounded-none border border-dashed border-neutral-300 bg-white px-3 py-4 font-mono text-[14px] leading-[20px] text-neutral-900"
      style={{ width: `${widthPx}px` }}
    >
      {voided ? (
        <div className="space-y-1 text-center" data-testid="receipt-pembatalan-banner">
          <p className="text-base font-bold tracking-widest text-red-800">
            *** {intl.formatMessage({ id: "receipt.pembatalan.banner" })} ***
          </p>
          <p className="text-[11px] text-neutral-700">
            {intl.formatMessage({ id: "receipt.pembatalan.reference" })}
          </p>
        </div>
      ) : null}
      {salinan ? (
        <p
          className="text-center font-bold tracking-widest text-neutral-900"
          data-testid="receipt-salinan-banner"
        >
          *** {intl.formatMessage({ id: "receipt.salinan.banner" })} ***
        </p>
      ) : null}
      <header className="text-center" data-testid="receipt-header">
        {merchant ? (
          <div data-testid="receipt-merchant">
            <p className="font-bold uppercase" data-testid="receipt-merchant-name">
              {merchant.displayName}
            </p>
            {merchant.addressLine ? (
              <p className="text-[12px] text-neutral-700" data-testid="receipt-merchant-address">
                {merchant.addressLine}
              </p>
            ) : null}
            {merchant.phone ? (
              <p className="text-[12px] text-neutral-700" data-testid="receipt-merchant-phone">
                {merchant.phone}
              </p>
            ) : null}
            {merchant.npwp ? (
              <p className="text-[12px] text-neutral-700" data-testid="receipt-merchant-npwp">
                {npwpLabel} {merchant.npwp}
              </p>
            ) : null}
            <p className="text-[12px] text-neutral-700" data-testid="receipt-outlet-name">
              {outlet?.name ?? intl.formatMessage({ id: "receipt.outlet.unknown" })}
            </p>
          </div>
        ) : (
          <p className="font-bold uppercase" data-testid="receipt-outlet-name">
            {outlet?.name ?? intl.formatMessage({ id: "receipt.outlet.unknown" })}
          </p>
        )}
        <p className="text-[12px] text-neutral-700">
          {formatDateTime(sale.createdAt, outlet?.timezone)}
        </p>
        <p className="text-[11px] text-neutral-600">ID {sale.localSaleId.slice(0, 8)}</p>
      </header>
      <hr className="my-2 border-dashed border-neutral-400" />
      <ul data-testid="receipt-lines" className="space-y-1">
        {sale.items.map((item) => (
          <li
            key={item.itemId}
            className="flex items-baseline justify-between gap-2 tabular-nums"
            data-tabular="true"
          >
            <span className="truncate">
              {item.quantity}× {item.itemId.slice(0, 8)}
            </span>
            <span>{formatIdr(item.lineTotalIdr)}</span>
          </li>
        ))}
      </ul>
      <hr className="my-2 border-dashed border-neutral-400" />
      <dl className="space-y-1 tabular-nums" data-tabular="true">
        <Row
          label={intl.formatMessage({ id: "receipt.subtotal" })}
          value={formatIdr(sale.subtotalIdr)}
        />
        {(sale.discountIdr as number) > 0 ? (
          <Row
            label={intl.formatMessage({ id: "receipt.discount" })}
            value={`-${formatIdr(sale.discountIdr)}`}
          />
        ) : null}
        {sale.taxIdr !== undefined && (sale.taxIdr as number) > 0 ? (
          <Row
            label={intl.formatMessage({ id: "receipt.tax" }, { rate: 11 })}
            value={formatIdr(sale.taxIdr)}
            data-testid="receipt-tax"
          />
        ) : null}
        <Row
          label={intl.formatMessage({ id: "receipt.total" })}
          value={formatIdr(sale.totalIdr)}
          strong
        />
        <Row
          label={intl.formatMessage({ id: "receipt.tendered" })}
          value={formatIdr(totalTendered)}
        />
        <Row label={intl.formatMessage({ id: "receipt.change" })} value={formatIdr(change)} />
      </dl>
      {qrisVoided ? (
        <p
          className="mt-2 text-center text-[12px] font-semibold text-red-800"
          data-testid="receipt-qris-refund-line"
        >
          {intl.formatMessage({ id: "receipt.pembatalan.qrisRefund" })}
        </p>
      ) : null}
      <hr className="my-2 border-dashed border-neutral-400" />
      <footer className="text-center text-[12px]" data-testid="receipt-footer">
        {footerText}
      </footer>
    </article>
  );
}

function Row({
  label,
  value,
  strong,
  ...rest
}: {
  label: string;
  value: string;
  strong?: boolean;
  [key: `data-${string}`]: string | undefined;
}) {
  return (
    <div
      {...rest}
      className={["flex items-baseline justify-between gap-2", strong ? "font-bold" : ""].join(" ")}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
